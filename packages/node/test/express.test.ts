import type { AddressInfo } from "node:net";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { auditstream } from "../src/express.js";
import { type Actor, AuditstreamError, audit } from "../src/index.js";

class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  public constructor(permits: number) {
    this.available = permits;
  }

  public async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available === 0) {
      await new Promise<void>((resolvePermit) => {
        this.queue.push(resolvePermit);
      });
    } else {
      this.available -= 1;
    }

    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next !== undefined) {
        next();
      } else {
        this.available += 1;
      }
    }
  }
}

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("listening", () => resolveListen());
    server.once("error", rejectListen);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      }),
  };
}

describe("@auditstream/node/express", () => {
  const semaphore = new Semaphore(5);
  let serverUrl = "";
  let closeServer: () => Promise<void> = async () => {};
  const resolverCalls = new Map<string, number>();

  beforeAll(async () => {
    const app = express();

    app.use(
      auditstream({
        actor: async (req) => {
          const reqKey = req.header("x-request-key") ?? "unknown";
          resolverCalls.set(reqKey, (resolverCalls.get(reqKey) ?? 0) + 1);

          const actorId = req.header("x-actor-id");
          if (!actorId) {
            return undefined;
          }
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1));
          return {
            type: "user",
            id: actorId,
            tenant: req.header("x-tenant") ?? undefined,
          } as Actor;
        },
        context: (req) => {
          const requestId = req.header("x-request-id");
          return requestId ? { requestId, source: "api" } : undefined;
        },
      }),
    );

    app.get("/check/:index", async (req, res) => {
      const index = Number(req.params.index);
      const before = audit.current();

      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, (index * 7) % 19));
      const afterTimer = audit.current();

      await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
      const afterImmediate = audit.current();

      const insideSemaphore = await semaphore.run(async () => {
        const atEntry = audit.current();
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, (index * 3) % 11));
        return { atEntry, atExit: audit.current() };
      });

      res.json({
        before,
        afterTimer,
        afterImmediate,
        insideSemaphore,
      });
    });

    const started = await startServer(app);
    serverUrl = started.url;
    closeServer = started.close;
  });

  afterAll(async () => {
    await closeServer();
  });

  it("isolates 40 concurrent HTTP requests across delays, setImmediate and a 5-slot semaphore", async () => {
    const total = 40;
    const responses = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const expectedId = `usr_express_${index}`;
        const reqKey = `express_req_${index}`;
        const res = await fetch(`${serverUrl}/check/${index}`, {
          headers: {
            "x-actor-id": expectedId,
            "x-tenant": `org_${index % 4}`,
            "x-request-id": reqKey,
            "x-request-key": reqKey,
          },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          before: { actor: Actor; context?: { requestId?: string; source?: string } };
          afterTimer: { actor: Actor };
          afterImmediate: { actor: Actor };
          insideSemaphore: { atEntry: { actor: Actor }; atExit: { actor: Actor } };
        };
        return { index, expectedId, reqKey, body };
      }),
    );

    for (const { index, expectedId, reqKey, body } of responses) {
      expect(resolverCalls.get(reqKey)).toBe(1);
      expect(body.before.actor.id).toBe(expectedId);
      expect(body.before.actor.tenant).toBe(`org_${index % 4}`);
      expect(body.before.context).toEqual({ requestId: reqKey, source: "api" });
      expect(body.afterTimer.actor.id).toBe(expectedId);
      expect(body.afterImmediate.actor.id).toBe(expectedId);
      expect(body.insideSemaphore.atEntry.actor.id).toBe(expectedId);
      expect(body.insideSemaphore.atExit.actor.id).toBe(expectedId);
    }
    expect(audit.current()).toBeUndefined();
  });

  it("runs the handler with no scope when the resolver returns undefined", async () => {
    const res = await fetch(`${serverUrl}/check/0`, {
      headers: { "x-request-key": "express_anonymous" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      before: unknown;
      afterTimer: unknown;
      insideSemaphore: { atEntry: unknown; atExit: unknown };
    };
    expect(resolverCalls.get("express_anonymous")).toBe(1);
    expect(body.before).toBeUndefined();
    expect(body.afterTimer).toBeUndefined();
    expect(body.insideSemaphore.atEntry).toBeUndefined();
    expect(body.insideSemaphore.atExit).toBeUndefined();
  });

  it("forwards synchronous resolver throws, async rejections, and invalid actors to Express error handler without calling the route handler", async () => {
    const handlerSpy = vi.fn();
    const receivedErrors: unknown[] = [];

    const app = express();
    app.use(
      auditstream({
        actor: (req) => {
          const mode = req.header("x-mode");
          if (mode === "sync-throw") {
            throw new Error("sync resolver boom");
          }
          if (mode === "async-reject") {
            return Promise.reject(new Error("async resolver boom"));
          }
          if (mode === "invalid-actor") {
            return { type: "bogus" as Actor["type"], id: "x" };
          }
          return { type: "user", id: "ok" };
        },
      }),
    );

    app.get("/target", (_req, res) => {
      handlerSpy();
      res.json({ ok: true });
    });

    const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
      receivedErrors.push(err);
      res.status(500).json({
        message: err instanceof Error ? err.message : String(err),
        code: err instanceof AuditstreamError ? err.code : undefined,
      });
    };
    app.use(errorHandler);

    const started = await startServer(app);
    try {
      for (const mode of ["sync-throw", "async-reject", "invalid-actor"]) {
        const res = await fetch(`${started.url}/target`, { headers: { "x-mode": mode } });
        expect(res.status).toBe(500);
      }
      expect(handlerSpy).not.toHaveBeenCalled();
      expect(receivedErrors).toHaveLength(3);
      expect((receivedErrors[0] as Error).message).toBe("sync resolver boom");
      expect((receivedErrors[1] as Error).message).toBe("async resolver boom");
      expect(receivedErrors[2]).toBeInstanceOf(AuditstreamError);
      expect((receivedErrors[2] as AuditstreamError).code).toBe("INVALID_ACTOR");
    } finally {
      await started.close();
    }
  });

  it("supports typed Express Request generics via explicit type arg, parameter annotation, and narrowed params", async () => {
    interface AuthedRequest extends Request {
      user?: { id: string; tenantId?: string };
      traceTag?: string;
    }

    type OrgRequest = Request<{ orgId: string }> & {
      user?: { id: string };
    };

    const app = express();

    // Upstream auth middleware populates typed properties on `req`.
    app.use("/api", (req, _res, next) => {
      const authed = req as AuthedRequest;
      const userId = req.header("x-user-id");
      const tenantId = req.header("x-tenant-id");
      if (userId) {
        authed.user = tenantId ? { id: userId, tenantId } : { id: userId };
      }
      const traceTag = req.header("x-trace-tag");
      if (traceTag) {
        authed.traceTag = traceTag;
      }
      next();
    });

    // 1. Explicit generic `auditstream<AuthedRequest>({ ... })` with zero casts in callbacks
    app.use(
      "/api/explicit",
      auditstream<AuthedRequest>({
        actor: (req) => {
          expectTypeOf(req.user).toEqualTypeOf<{ id: string; tenantId?: string } | undefined>();
          if (!req.user) {
            return undefined;
          }
          return req.user.tenantId
            ? { type: "user", id: req.user.id, tenant: req.user.tenantId }
            : { type: "user", id: req.user.id };
        },
        context: (req) => {
          expectTypeOf(req.traceTag).toEqualTypeOf<string | undefined>();
          return req.traceTag ? { requestId: req.traceTag, source: "express-explicit" } : undefined;
        },
      }),
    );

    // 2. Parameter-annotated inference propagates `AuthedRequest` into `context` automatically
    app.use(
      "/api/annotated",
      auditstream({
        actor: (req: AuthedRequest) => (req.user ? { type: "user", id: req.user.id } : undefined),
        context: (req) => {
          expectTypeOf(req.traceTag).toEqualTypeOf<string | undefined>();
          return req.traceTag
            ? { requestId: req.traceTag, source: "express-annotated" }
            : undefined;
        },
      }),
    );

    // 3. Narrowed route-params request subtype satisfies `TRequest extends Request`
    const orgMiddleware = auditstream<OrgRequest>({
      actor: (req) => {
        expectTypeOf(req.params.orgId).toEqualTypeOf<string>();
        return req.user ? { type: "user", id: req.user.id, tenant: req.params.orgId } : undefined;
      },
    });
    app.get("/api/orgs/:orgId", orgMiddleware, (_req, res) => {
      res.json({ scope: audit.current() ?? null });
    });

    app.get("/api/explicit", (_req, res) => {
      res.json({ scope: audit.current() ?? null });
    });
    app.get("/api/annotated", (_req, res) => {
      res.json({ scope: audit.current() ?? null });
    });

    const started = await startServer(app);
    try {
      const explicitRes = await fetch(`${started.url}/api/explicit`, {
        headers: { "x-user-id": "usr_exp_1", "x-tenant-id": "org_1", "x-trace-tag": "req_exp_1" },
      });
      expect(explicitRes.status).toBe(200);
      expect(await explicitRes.json()).toEqual({
        scope: {
          actor: { type: "user", id: "usr_exp_1", tenant: "org_1" },
          context: { requestId: "req_exp_1", source: "express-explicit" },
        },
      });

      const annotatedRes = await fetch(`${started.url}/api/annotated`, {
        headers: { "x-user-id": "usr_exp_2", "x-trace-tag": "req_exp_2" },
      });
      expect(annotatedRes.status).toBe(200);
      expect(await annotatedRes.json()).toEqual({
        scope: {
          actor: { type: "user", id: "usr_exp_2" },
          context: { requestId: "req_exp_2", source: "express-annotated" },
        },
      });

      const orgRes = await fetch(`${started.url}/api/orgs/org_77`, {
        headers: { "x-user-id": "usr_exp_3" },
      });
      expect(orgRes.status).toBe(200);
      expect(await orgRes.json()).toEqual({
        scope: { actor: { type: "user", id: "usr_exp_3", tenant: "org_77" } },
      });
    } finally {
      await started.close();
    }
  });

  it("supports typed Express res.locals generics and does not call next() when a resolver already sent a response", async () => {
    interface AuthLocals {
      user?: { id: string; tenantId?: string };
      requestTag?: string;
    }

    const blockedHandlerSpy = vi.fn();
    const app = express();

    app.use("/locals", (req, res, next) => {
      const userId = req.header("x-user-id");
      const tenantId = req.header("x-tenant-id");
      if (userId) {
        res.locals.user = tenantId ? { id: userId, tenantId } : { id: userId };
      }
      const tag = req.header("x-trace-tag");
      if (tag) {
        res.locals.requestTag = tag;
      }
      next();
    });

    // 1. Explicit <Request, AuthLocals>
    app.use(
      "/locals/explicit",
      auditstream<Request, AuthLocals>({
        actor: (_req, res) => {
          expectTypeOf(res.locals.user).toEqualTypeOf<
            { id: string; tenantId?: string } | undefined
          >();
          const user = res.locals.user;
          if (!user) {
            return undefined;
          }
          return user.tenantId
            ? { type: "user", id: user.id, tenant: user.tenantId }
            : { type: "user", id: user.id };
        },
        context: (_req, res) => {
          expectTypeOf(res.locals.requestTag).toEqualTypeOf<string | undefined>();
          return res.locals.requestTag
            ? { requestId: res.locals.requestTag, source: "locals-explicit" }
            : undefined;
        },
      }),
    );

    // 2. Parameter-annotated `res: Response<unknown, AuthLocals>` propagates into `context`
    app.use(
      "/locals/annotated",
      auditstream({
        actor: (_req, res: Response<unknown, AuthLocals>) =>
          res.locals.user ? { type: "user", id: res.locals.user.id } : undefined,
        context: (_req, res) => {
          expectTypeOf(res.locals.requestTag).toEqualTypeOf<string | undefined>();
          return res.locals.requestTag
            ? { requestId: res.locals.requestTag, source: "locals-annotated" }
            : undefined;
        },
      }),
    );

    // 3. Default unparameterized `res.locals` values are `unknown`, never `any`
    app.use(
      "/locals/default",
      auditstream({
        actor: (_req, res) => {
          expectTypeOf(res.locals.user).toEqualTypeOf<unknown>();
          const user = res.locals.user;
          if (
            typeof user === "object" &&
            user !== null &&
            "id" in user &&
            typeof user.id === "string"
          ) {
            return { type: "user", id: user.id };
          }
          return undefined;
        },
      }),
    );

    // 4. Short-circuit response inside sync/async actor or context must NOT invoke downstream handler
    app.use(
      "/locals/short-circuit-sync",
      auditstream<Request, AuthLocals>({
        actor: (req, res) => {
          if (req.header("x-short") === "sync-actor") {
            res.status(401).json({ error: "sync-denied" });
            return undefined;
          }
          return { type: "user", id: "usr_ctx_short" };
        },
        context: (req, res) => {
          if (req.header("x-short") === "sync-context") {
            res.status(403).json({ error: "sync-context-denied" });
            return undefined;
          }
          if (req.header("x-short") === "async-context") {
            return Promise.resolve().then(() => {
              res.status(403).json({ error: "async-context-denied" });
              return undefined;
            });
          }
          return { source: "locals" };
        },
      }),
    );

    app.use(
      "/locals/short-circuit-async",
      auditstream<Request, AuthLocals>({
        actor: async (req, res) => {
          await Promise.resolve();
          if (req.header("x-short") === "async-actor") {
            res.status(401).json({ error: "async-denied" });
            return undefined;
          }
          return { type: "user", id: "usr_async_ctx_short" };
        },
        context: async (req, res) => {
          await Promise.resolve();
          if (req.header("x-short") === "async-actor-context") {
            res.status(403).json({ error: "async-actor-context-denied" });
            return undefined;
          }
          return { source: "locals" };
        },
      }),
    );

    app.get("/locals/explicit", (_req, res) => {
      res.json({ scope: audit.current() ?? null });
    });
    app.get("/locals/annotated", (_req, res) => {
      res.json({ scope: audit.current() ?? null });
    });
    app.get("/locals/default", (_req, res) => {
      res.json({ scope: audit.current() ?? null });
    });
    app.get("/locals/short-circuit-sync", (_req, res) => {
      blockedHandlerSpy();
      res.json({ ok: true });
    });
    app.get("/locals/short-circuit-async", (_req, res) => {
      blockedHandlerSpy();
      res.json({ ok: true });
    });

    const started = await startServer(app);
    try {
      const explicitRes = await fetch(`${started.url}/locals/explicit`, {
        headers: { "x-user-id": "usr_loc_1", "x-tenant-id": "org_loc", "x-trace-tag": "req_loc_1" },
      });
      expect(explicitRes.status).toBe(200);
      expect(await explicitRes.json()).toEqual({
        scope: {
          actor: { type: "user", id: "usr_loc_1", tenant: "org_loc" },
          context: { requestId: "req_loc_1", source: "locals-explicit" },
        },
      });

      const annotatedRes = await fetch(`${started.url}/locals/annotated`, {
        headers: { "x-user-id": "usr_loc_2", "x-trace-tag": "req_loc_2" },
      });
      expect(annotatedRes.status).toBe(200);
      expect(await annotatedRes.json()).toEqual({
        scope: {
          actor: { type: "user", id: "usr_loc_2" },
          context: { requestId: "req_loc_2", source: "locals-annotated" },
        },
      });

      const defaultRes = await fetch(`${started.url}/locals/default`, {
        headers: { "x-user-id": "usr_loc_3" },
      });
      expect(defaultRes.status).toBe(200);
      expect(await defaultRes.json()).toEqual({
        scope: { actor: { type: "user", id: "usr_loc_3" } },
      });

      for (const [path, mode, expectedStatus] of [
        ["/locals/short-circuit-sync", "sync-actor", 401],
        ["/locals/short-circuit-sync", "sync-context", 403],
        ["/locals/short-circuit-sync", "async-context", 403],
        ["/locals/short-circuit-async", "async-actor", 401],
        ["/locals/short-circuit-async", "async-actor-context", 403],
      ] as const) {
        const res = await fetch(`${started.url}${path}`, {
          headers: { "x-short": mode },
        });
        expect(res.status).toBe(expectedStatus);
      }
      expect(blockedHandlerSpy).not.toHaveBeenCalled();
    } finally {
      await started.close();
    }
  });
});
