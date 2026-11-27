import { type Context, Hono, type MiddlewareHandler } from "hono";
import { createFactory } from "hono/factory";
import type { JwtVariables } from "hono/jwt";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { auditstream } from "../src/hono.js";
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

describe("@auditstream/node/hono", () => {
  it("isolates 40 concurrent requests via app.request() and keeps scope open until next() settles", async () => {
    const semaphore = new Semaphore(5);
    const resolverCalls = new Map<string, number>();
    const afterNextActors = new Map<string, string | undefined>();

    const app = new Hono();

    app.use(
      "*",
      auditstream({
        actor: async (c) => {
          const reqKey = c.req.header("x-request-key") ?? "unknown";
          resolverCalls.set(reqKey, (resolverCalls.get(reqKey) ?? 0) + 1);

          const actorId = c.req.header("x-actor-id");
          if (!actorId) {
            return undefined;
          }
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1));
          const tenant = c.req.header("x-tenant");
          return tenant ? { type: "user", id: actorId, tenant } : { type: "user", id: actorId };
        },
        context: (c) => {
          const requestId = c.req.header("x-request-id");
          return requestId ? { requestId, source: "hono" } : undefined;
        },
      }),
    );

    // Downstream middleware confirms the scope stays open across the entire next() lifecycle.
    app.use("*", async (c, next) => {
      const reqKey = c.req.header("x-request-key") ?? "unknown";
      await next();
      afterNextActors.set(reqKey, audit.current()?.actor.id);
    });

    app.get("/check/:index", async (c) => {
      const index = Number(c.req.param("index"));
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

      return c.json({
        before: before ?? null,
        afterTimer: afterTimer ?? null,
        afterImmediate: afterImmediate ?? null,
        insideSemaphore: {
          atEntry: insideSemaphore.atEntry ?? null,
          atExit: insideSemaphore.atExit ?? null,
        },
      });
    });

    const total = 40;
    const responses = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const expectedId = `usr_hono_${index}`;
        const reqKey = `hono_req_${index}`;
        const res = await app.request(`/check/${index}`, {
          headers: {
            "x-actor-id": expectedId,
            "x-tenant": `org_${index % 4}`,
            "x-request-id": reqKey,
            "x-request-key": reqKey,
          },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          before: { actor: Actor; context?: { requestId?: string; source?: string } } | null;
          afterTimer: { actor: Actor } | null;
          afterImmediate: { actor: Actor } | null;
          insideSemaphore: { atEntry: { actor: Actor } | null; atExit: { actor: Actor } | null };
        };
        return { index, expectedId, reqKey, body };
      }),
    );

    for (const { index, expectedId, reqKey, body } of responses) {
      expect(resolverCalls.get(reqKey)).toBe(1);
      expect(body.before?.actor.id).toBe(expectedId);
      expect(body.before?.actor.tenant).toBe(`org_${index % 4}`);
      expect(body.before?.context).toEqual({ requestId: reqKey, source: "hono" });
      expect(body.afterTimer?.actor.id).toBe(expectedId);
      expect(body.afterImmediate?.actor.id).toBe(expectedId);
      expect(body.insideSemaphore.atEntry?.actor.id).toBe(expectedId);
      expect(body.insideSemaphore.atExit?.actor.id).toBe(expectedId);
      expect(afterNextActors.get(reqKey)).toBe(expectedId);
    }

    // Anonymous request runs with no scope.
    const anonRes = await app.request("/check/0", {
      headers: { "x-request-key": "hono_anonymous" },
    });
    expect(anonRes.status).toBe(200);
    const anonBody = (await anonRes.json()) as { before: unknown; afterTimer: unknown };
    expect(resolverCalls.get("hono_anonymous")).toBe(1);
    expect(anonBody.before).toBeNull();
    expect(anonBody.afterTimer).toBeNull();
    expect(afterNextActors.get("hono_anonymous")).toBeUndefined();
    expect(audit.current()).toBeUndefined();
  });

  it("propagates resolver errors and invalid actor errors to Hono onError without calling the handler", async () => {
    const handlerSpy = vi.fn();
    const errors: Error[] = [];

    const app = new Hono();
    app.onError((err, c) => {
      errors.push(err);
      return c.json({ message: err.message }, 500);
    });

    app.use(
      "*",
      auditstream({
        actor: (c) => {
          if (c.req.header("x-mode") === "throw") {
            throw new Error("hono resolver failed");
          }
          return { type: "invalid" as Actor["type"], id: "x" };
        },
      }),
    );

    app.get("/target", (c) => {
      handlerSpy();
      return c.text("ok");
    });

    const throwRes = await app.request("/target", { headers: { "x-mode": "throw" } });
    expect(throwRes.status).toBe(500);

    const invalidRes = await app.request("/target", { headers: { "x-mode": "invalid" } });
    expect(invalidRes.status).toBe(500);

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toBe("hono resolver failed");
    expect(errors[1]).toBeInstanceOf(AuditstreamError);
    expect((errors[1] as AuditstreamError).code).toBe("INVALID_ACTOR");
  });

  it("supports typed Hono Env generics across explicit, annotated, factory, and extended apps without degrading route params", async () => {
    type AppEnv = {
      Variables: {
        authUserId?: string;
        tenantId?: string;
        requestTag?: string;
      };
      Bindings: {
        SERVICE_NAME: string;
      };
    };

    type ExtendedEnv = {
      Variables: AppEnv["Variables"] & { extraFlag: boolean };
      Bindings: AppEnv["Bindings"];
    };

    type JwtAppEnv = {
      Variables: JwtVariables<{ sub?: unknown } | undefined>;
    };

    // 1. Explicit generic `auditstream<AppEnv>({ ... })` + mounting on extended Hono<ExtendedEnv>
    const typedMiddleware: MiddlewareHandler<AppEnv> = auditstream<AppEnv>({
      actor: (c) => {
        expectTypeOf(c.get("authUserId")).toEqualTypeOf<string | undefined>();
        expectTypeOf(c.get("tenantId")).toEqualTypeOf<string | undefined>();
        expectTypeOf(c.env.SERVICE_NAME).toEqualTypeOf<string>();
        const userId = c.get("authUserId")?.trim();
        if (!userId) {
          return undefined;
        }
        const tenant = c.get("tenantId")?.trim();
        return tenant ? { type: "user", id: userId, tenant } : { type: "user", id: userId };
      },
      context: (c) => {
        expectTypeOf(c.get("requestTag")).toEqualTypeOf<string | undefined>();
        expectTypeOf(c.env.SERVICE_NAME).toEqualTypeOf<string>();
        const requestId = c.get("requestTag");
        return requestId
          ? { requestId, source: c.env.SERVICE_NAME }
          : { source: c.env.SERVICE_NAME };
      },
    });

    const extApp = new Hono<ExtendedEnv>();
    extApp.use("*", async (c, next) => {
      c.set("authUserId", c.req.header("x-user-id") ?? undefined);
      c.set("tenantId", c.req.header("x-tenant-id") ?? undefined);
      c.set("requestTag", c.req.header("x-req-tag") ?? undefined);
      c.set("extraFlag", true);
      await next();
    });
    extApp.use("*", typedMiddleware);
    extApp.get("/orgs/:orgId/items", (c) => {
      // Omitting P & I type parameters preserves narrow route-param inference downstream.
      const orgId = c.req.param("orgId");
      expectTypeOf(orgId).toEqualTypeOf<string>();
      return c.json({
        orgId,
        extra: c.get("extraFlag"),
        scope: audit.current() ?? null,
      });
    });

    const extRes = await extApp.request(
      "/orgs/org_9/items",
      {
        headers: {
          "x-user-id": "usr_typed_1",
          "x-tenant-id": "org_9",
          "x-req-tag": "req_typed_1",
        },
      },
      { SERVICE_NAME: "typed-hono" },
    );
    expect(extRes.status).toBe(200);
    const extBody = (await extRes.json()) as {
      orgId: string;
      extra: boolean;
      scope: { actor: Actor; context?: { requestId?: string; source?: string } } | null;
    };
    expect(extBody).toEqual({
      orgId: "org_9",
      extra: true,
      scope: {
        actor: { type: "user", id: "usr_typed_1", tenant: "org_9" },
        context: { requestId: "req_typed_1", source: "typed-hono" },
      },
    });

    // 2. Parameter-annotated `c: Context<AppEnv>` propagates `AppEnv` to `context` without poisoning `P`
    const annotatedMiddleware = auditstream({
      actor: (c: Context<AppEnv>) => {
        const userId = c.get("authUserId");
        return userId ? { type: "user", id: userId } : undefined;
      },
      context: (c) => {
        expectTypeOf(c.get("requestTag")).toEqualTypeOf<string | undefined>();
        const requestId = c.get("requestTag");
        return requestId ? { requestId, source: "annotated" } : undefined;
      },
    });

    const annotatedApp = new Hono<AppEnv>();
    annotatedApp.get("/orgs/:orgId/check", annotatedMiddleware, (c) => {
      const orgId = c.req.param("orgId");
      expectTypeOf(orgId).toEqualTypeOf<string>();
      return c.json({ orgId });
    });

    // 3. Hono `createFactory<AppEnv>().createMiddleware(...)` infers `AppEnv` with zero type arguments
    const factory = createFactory<AppEnv>();
    const factoryMiddleware = factory.createMiddleware(
      auditstream({
        actor: (c) => {
          expectTypeOf(c.get("authUserId")).toEqualTypeOf<string | undefined>();
          const userId = c.get("authUserId");
          return userId ? { type: "user", id: userId } : undefined;
        },
        context: (c) => {
          expectTypeOf(c.get("requestTag")).toEqualTypeOf<string | undefined>();
          return { source: "factory" };
        },
      }),
    );

    const factoryApp = factory.createApp();
    factoryApp.use("*", async (c, next) => {
      c.set("authUserId", "usr_factory_1");
      await next();
    });
    factoryApp.use("*", factoryMiddleware);
    factoryApp.get("/factory", (c) => c.json({ scope: audit.current() ?? null }));

    const factoryRes = await factoryApp.request("/factory");
    expect(factoryRes.status).toBe(200);
    expect(await factoryRes.json()).toEqual({
      scope: { actor: { type: "user", id: "usr_factory_1" }, context: { source: "factory" } },
    });

    // 4. Typed `JwtVariables` works without any `as` cast
    const jwtApp = new Hono<JwtAppEnv>();
    jwtApp.use("/api/*", async (c, next) => {
      c.set("jwtPayload", { sub: "usr_jwt_1" });
      await next();
    });
    jwtApp.use(
      "/api/*",
      auditstream<JwtAppEnv>({
        actor: (c) => {
          const payload = c.get("jwtPayload");
          expectTypeOf(payload).toEqualTypeOf<{ sub?: unknown } | undefined>();
          const rawSub = payload?.sub;
          const sub = typeof rawSub === "string" ? rawSub.trim() : "";
          return sub.length > 0 ? { type: "user", id: sub } : undefined;
        },
      }),
    );
    jwtApp.get("/api/me", (c) => c.json({ actor: audit.current()?.actor ?? null }));

    const jwtRes = await jwtApp.request("/api/me");
    expect(jwtRes.status).toBe(200);
    expect(await jwtRes.json()).toEqual({ actor: { type: "user", id: "usr_jwt_1" } });
  });
});
