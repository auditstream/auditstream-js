import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextRequest, NextResponse } from "next/server.js";
import { describe, expect, it, vi } from "vitest";
import { type Actor, type AuditScope, AuditstreamError, audit } from "../src/index.js";
import { auditAction, withAudit } from "../src/next.js";

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

// Compile-time type check: a Next.js 16 Route Handler with NextRequest, Promise params,
// and NextResponse compiles cleanly under the strict workspace tsconfig without runtime import.
type NextRouteContext = { params: Promise<{ id: string }> };
export const typedNextRouteHandler: (
  request: NextRequest,
  context: NextRouteContext,
) => Promise<NextResponse> = withAudit(
  async (request: NextRequest, context: NextRouteContext): Promise<NextResponse> => {
    await context.params;
    void request.nextUrl;
    return Response.json({ actor: audit.current()?.actor }) as unknown as NextResponse;
  },
  {
    actor: (request) => {
      const id = request.headers.get("x-actor-id");
      return id ? { type: "user", id } : undefined;
    },
    context: (request) => {
      const requestId = request.headers.get("x-request-id");
      return requestId ? { requestId, source: "web" } : undefined;
    },
  },
);

describe("@auditstream/node/next", () => {
  it("withAudit isolates 40 concurrent plain Request calls across delays, setImmediate and a 5-slot semaphore", async () => {
    const semaphore = new Semaphore(5);
    const resolverCalls = new Map<string, number>();

    const handler = withAudit(
      async (_request: Request, index: number) => {
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

        return Response.json({
          before: before ?? null,
          afterTimer: afterTimer ?? null,
          afterImmediate: afterImmediate ?? null,
          insideSemaphore: {
            atEntry: insideSemaphore.atEntry ?? null,
            atExit: insideSemaphore.atExit ?? null,
          },
        });
      },
      {
        actor: async (request) => {
          const reqKey = request.headers.get("x-request-key") ?? "unknown";
          resolverCalls.set(reqKey, (resolverCalls.get(reqKey) ?? 0) + 1);
          const id = request.headers.get("x-actor-id");
          if (!id) return undefined;
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1));
          const tenant = request.headers.get("x-tenant");
          return tenant ? { type: "user", id, tenant } : { type: "user", id };
        },
        context: (request) => {
          const requestId = request.headers.get("x-request-id");
          return requestId ? { requestId, source: "next-route" } : undefined;
        },
      },
    );

    const total = 40;
    const results = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const expectedId = `usr_next_route_${index}`;
        const reqKey = `next_route_${index}`;
        const req = new Request(`https://example.test/api/orders/${index}`, {
          headers: {
            "x-actor-id": expectedId,
            "x-tenant": `org_${index % 4}`,
            "x-request-id": reqKey,
            "x-request-key": reqKey,
          },
        });
        const res = await handler(req, index);
        const body = (await res.json()) as {
          before: { actor: Actor; context?: { requestId?: string; source?: string } } | null;
          afterTimer: { actor: Actor } | null;
          afterImmediate: { actor: Actor } | null;
          insideSemaphore: { atEntry: { actor: Actor } | null; atExit: { actor: Actor } | null };
        };
        return { index, expectedId, reqKey, body };
      }),
    );

    for (const { index, expectedId, reqKey, body } of results) {
      expect(resolverCalls.get(reqKey)).toBe(1);
      expect(body.before?.actor.id).toBe(expectedId);
      expect(body.before?.actor.tenant).toBe(`org_${index % 4}`);
      expect(body.before?.context).toEqual({ requestId: reqKey, source: "next-route" });
      expect(body.afterTimer?.actor.id).toBe(expectedId);
      expect(body.afterImmediate?.actor.id).toBe(expectedId);
      expect(body.insideSemaphore.atEntry?.actor.id).toBe(expectedId);
      expect(body.insideSemaphore.atExit?.actor.id).toBe(expectedId);
    }

    // Undefined actor runs handler with no scope.
    const anonRes = await handler(
      new Request("https://example.test/api/orders/anon", {
        headers: { "x-request-key": "next_route_anon" },
      }),
      0,
    );
    const anonBody = (await anonRes.json()) as { before: unknown };
    expect(resolverCalls.get("next_route_anon")).toBe(1);
    expect(anonBody.before).toBeNull();
    expect(audit.current()).toBeUndefined();
  });

  it("auditAction isolates 40 concurrent plain Request calls across delays, setImmediate and a 5-slot semaphore", async () => {
    const semaphore = new Semaphore(5);
    const resolverCalls = new Map<string, number>();

    const action = auditAction(
      async (_request: Request, index: number) => {
        const before = audit.current();
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, (index * 5) % 17));
        const afterTimer = audit.current();
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
        const afterImmediate = audit.current();
        const insideSemaphore = await semaphore.run(async () => {
          const atEntry = audit.current();
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, (index * 3) % 9));
          return { atEntry, atExit: audit.current() };
        });

        return { before, afterTimer, afterImmediate, insideSemaphore };
      },
      {
        actor: async (request) => {
          const reqKey = request.headers.get("x-request-key") ?? "unknown";
          resolverCalls.set(reqKey, (resolverCalls.get(reqKey) ?? 0) + 1);
          const id = request.headers.get("x-actor-id");
          if (!id) return undefined;
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1));
          return { type: "user", id };
        },
        context: (request) => {
          const requestId = request.headers.get("x-request-id");
          return requestId ? { requestId, source: "next-action" } : undefined;
        },
      },
    );

    const total = 40;
    const results = await Promise.all(
      Array.from({ length: total }, async (_, index) => {
        const expectedId = `usr_next_action_${index}`;
        const reqKey = `next_action_${index}`;
        const req = new Request(`https://example.test/actions/${index}`, {
          method: "POST",
          headers: {
            "x-actor-id": expectedId,
            "x-request-id": reqKey,
            "x-request-key": reqKey,
          },
        });
        const observed = await action(req, index);
        return { expectedId, reqKey, observed };
      }),
    );

    for (const { expectedId, reqKey, observed } of results) {
      expect(resolverCalls.get(reqKey)).toBe(1);
      expect(observed.before?.actor.id).toBe(expectedId);
      expect(observed.before?.context).toEqual({ requestId: reqKey, source: "next-action" });
      expect(observed.afterTimer?.actor.id).toBe(expectedId);
      expect(observed.afterImmediate?.actor.id).toBe(expectedId);
      expect(observed.insideSemaphore.atEntry?.actor.id).toBe(expectedId);
      expect(observed.insideSemaphore.atExit?.actor.id).toBe(expectedId);
    }

    const anonObserved = await action(
      new Request("https://example.test/actions/anon", {
        method: "POST",
        headers: { "x-request-key": "next_action_anon" },
      }),
      0,
    );
    expect(resolverCalls.get("next_action_anon")).toBe(1);
    expect(anonObserved.before).toBeUndefined();
    expect(audit.current()).toBeUndefined();
  });

  it("keeps the actor for lazy thenables and rejects invalid actors before running the handler/action", async () => {
    const lazyAction = auditAction(
      (_input: string): PromiseLike<AuditScope | undefined> => ({
        // biome-ignore lint/suspicious/noThenProperty: intentional lazy PromiseLike thenable test
        then<TResult1 = AuditScope | undefined, TResult2 = never>(
          onfulfilled?:
            | ((value: AuditScope | undefined) => TResult1 | PromiseLike<TResult1>)
            | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve(audit.current()).then(onfulfilled, onrejected);
        },
      }),
      { actor: () => ({ type: "user", id: "usr_lazy_action" }) },
    );
    expect(await lazyAction("go")).toEqual({ actor: { type: "user", id: "usr_lazy_action" } });

    const spy = vi.fn();
    const invalidRoute = withAudit(
      (_req: Request) => {
        spy();
        return Response.json({ ok: true });
      },
      { actor: () => ({ type: "bogus" as Actor["type"], id: "x" }) },
    );
    await expect(invalidRoute(new Request("https://example.test"))).rejects.toBeInstanceOf(
      AuditstreamError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not import next at runtime in the built @auditstream/node/next bundle", () => {
    const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const builtNext = readFileSync(resolve(pkgRoot, "dist/next.mjs"), "utf8");
    expect(builtNext).not.toMatch(/from\s+["']next(?:\/[^"']*)?["']/);
    expect(builtNext).not.toMatch(/import\s*\(\s*["']next(?:\/[^"']*)?["']\s*\)/);
    expect(builtNext).not.toMatch(/require\s*\(\s*["']next(?:\/[^"']*)?["']\s*\)/);
  });
});
