import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler, type Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
});
