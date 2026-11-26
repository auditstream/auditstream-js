import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type Actor,
  type ActorType,
  type AuditContext,
  type AuditScope,
  AuditstreamError,
  audit,
  MAX_PAYLOAD_BYTES,
  type NestedActor,
} from "../src/index.js";

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

function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (entry.isFile() && /\.(ts|mts|js|mjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe("audit.as() validation (spec 0.1.0)", () => {
  it("accepts all five valid actor types", async () => {
    const types: ActorType[] = ["user", "api_key", "ai_agent", "service", "system"];
    for (const type of types) {
      const observed = await audit.as({ type, id: `${type}_1` }, () => audit.current());
      expect(observed).toEqual({ actor: { type, id: `${type}_1` } });
    }
  });

  it("rejects an unknown actor type before calling fn", async () => {
    const fn = vi.fn();
    await expect(audit.as({ type: "bot" as ActorType, id: "bot_1" }, fn)).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_ACTOR",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty id before calling fn", async () => {
    const fn = vi.fn();
    await expect(audit.as({ type: "user" } as unknown as Actor, fn)).rejects.toBeInstanceOf(
      AuditstreamError,
    );
    await expect(audit.as({ type: "user", id: "" }, fn)).rejects.toMatchObject({
      code: "INVALID_ACTOR",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts one-level onBehalfOf and tenant (handbook example)", async () => {
    const handbookActor: Actor = {
      type: "ai_agent",
      id: "billing-agent",
      onBehalfOf: { type: "user", id: "usr_42" },
      tenant: "org_acme",
    };

    const scope = await audit.as(handbookActor, () => audit.current());
    expect(scope).toEqual({ actor: handbookActor });
  });

  it("rejects onBehalfOf deeper than one level before calling fn", async () => {
    const fn = vi.fn();
    const deepActor = {
      type: "ai_agent",
      id: "agent_1",
      onBehalfOf: {
        type: "service",
        id: "svc_1",
        onBehalfOf: { type: "user", id: "usr_1" },
      },
    } as unknown as Actor;

    await expect(audit.as(deepActor, fn)).rejects.toMatchObject({
      code: "INVALID_ACTOR",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects empty or non-string tenant before calling fn", async () => {
    const fn = vi.fn();
    await expect(audit.as({ type: "user", id: "usr_1", tenant: "" }, fn)).rejects.toMatchObject({
      code: "INVALID_ACTOR",
    });
    await expect(
      audit.as({ type: "user", id: "usr_1", tenant: 123 } as unknown as Actor, fn),
    ).rejects.toMatchObject({
      code: "INVALID_ACTOR",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts valid context fields and rejects invalid context", async () => {
    const context: AuditContext = {
      requestId: "req_01",
      source: "api",
      ip: "203.0.113.10",
      userAgent: "auditstream-test/1.0",
    };

    const scope = await audit.as({ type: "user", id: "usr_1" }, () => audit.current(), { context });
    expect(scope).toEqual({
      actor: { type: "user", id: "usr_1" },
      context,
    });

    const fn = vi.fn();
    await expect(
      audit.as({ type: "user", id: "usr_1" }, fn, {
        context: "web" as unknown as AuditContext,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    await expect(
      audit.as({ type: "user", id: "usr_1" }, fn, {
        context: { requestId: "" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("enforces the 512-byte UTF-8 compact JSON payload limit", async () => {
    // '{"type":"user","id":""}' is 23 ASCII bytes; pad with 244 * 2-byte "é" + 1 ASCII "a" = 512 bytes.
    const exact512Id = `${"é".repeat((MAX_PAYLOAD_BYTES - 24) / 2)}a`;
    const exactPayload = JSON.stringify({ type: "user", id: exact512Id });
    expect(new TextEncoder().encode(exactPayload).byteLength).toBe(512);

    const observed = await audit.as({ type: "user", id: exact512Id }, () => audit.current());
    expect(observed?.actor.id).toBe(exact512Id);

    const fn = vi.fn();
    const overLimitId = `${exact512Id}a`;
    expect(
      new TextEncoder().encode(JSON.stringify({ type: "user", id: overLimitId })).byteLength,
    ).toBe(513);

    await expect(audit.as({ type: "user", id: overLimitId }, fn)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("rejects prototype-hijacking keys, non-plain prototypes, throwing getters, and hostile Proxies in audit.as() before calling fn", async () => {
    const fn = vi.fn();

    const protoBoom = new Proxy(
      { type: "user", id: "u1" },
      {
        getPrototypeOf(): never {
          throw new Error("getPrototypeOf boom");
        },
      },
    );
    const { proxy: revokedActor, revoke: revokeActor } = Proxy.revocable(
      { type: "user", id: "u1" },
      {},
    );
    revokeActor();
    const { proxy: revokedOptions, revoke: revokeOptions } = Proxy.revocable({}, {});
    revokeOptions();

    const badActors: readonly unknown[] = [
      JSON.parse('{"type":"user","id":"u1","__proto__":{"tenant":"evil"}}'),
      JSON.parse('{"type":"user","id":"u1","constructor":{"x":1}}'),
      JSON.parse('{"type":"user","id":"u1","prototype":{"x":1}}'),
      {
        type: "ai_agent",
        id: "a1",
        onBehalfOf: JSON.parse('{"type":"user","id":"u1","__proto__":{"tenant":"evil"}}'),
      },
      {
        type: "user",
        id: "u1",
        extra: { nested: JSON.parse('{"__proto__":{"x":1}}') },
      },
      Object.assign(Object.create({ tenant: "spoofed" }) as Record<string, unknown>, {
        type: "user",
        id: "u1",
      }),
      {
        type: "ai_agent",
        id: "a1",
        onBehalfOf: Object.assign(Object.create({ tenant: "spoofed" }) as Record<string, unknown>, {
          type: "user",
          id: "u1",
        }),
      },
      {
        type: "user",
        id: "u1",
        get unused(): string {
          throw new Error("getter boom");
        },
      },
      protoBoom,
      revokedActor,
    ];

    for (const actor of badActors) {
      await expect(audit.as(actor as Actor, fn)).rejects.toMatchObject({
        name: "AuditstreamError",
        code: "INVALID_ACTOR",
      });
    }

    const badContexts: readonly unknown[] = [
      JSON.parse('{"requestId":"r1","__proto__":{"source":"evil"}}'),
      JSON.parse('{"constructor":{"x":1}}'),
      JSON.parse('{"nested":{"prototype":1}}'),
      Object.assign(Object.create({ source: "spoofed" }) as Record<string, unknown>, {
        requestId: "r1",
      }),
      {
        requestId: "r1",
        get unused(): string {
          throw new Error("context getter boom");
        },
      },
      protoBoom,
      revokedActor,
    ];

    for (const context of badContexts) {
      await expect(
        audit.as({ type: "user", id: "u1" }, fn, { context: context as AuditContext }),
      ).rejects.toMatchObject({
        name: "AuditstreamError",
        code: "INVALID_CONTEXT",
      });
    }

    await expect(
      audit.as({ type: "user", id: "u1" }, fn, {
        get context(): AuditContext {
          throw new Error("options.context boom");
        },
      }),
    ).rejects.toMatchObject({ name: "AuditstreamError", code: "INVALID_CONTEXT" });
    await expect(
      audit.as(
        { type: "user", id: "u1" },
        fn,
        revokedOptions as unknown as { context?: AuditContext },
      ),
    ).rejects.toMatchObject({ name: "AuditstreamError", code: "INVALID_CONTEXT" });

    expect(fn).not.toHaveBeenCalled();

    // Null-prototype plain objects without forbidden keys remain valid.
    const nullProtoActor = Object.assign(Object.create(null) as Record<string, unknown>, {
      type: "user",
      id: "usr_null",
    }) as unknown as Actor;
    const observed = await audit.as(nullProtoActor, () => audit.current());
    expect(observed).toEqual({ actor: { type: "user", id: "usr_null" } });
  });
});

describe("audit.as() scope propagation", () => {
  it("returns undefined outside any scope and restores outer actor across nested scopes", async () => {
    expect(audit.current()).toBeUndefined();

    const outer: NestedActor = { type: "user", id: "outer_user" };
    const inner: Actor = { type: "ai_agent", id: "inner_agent", onBehalfOf: outer };

    await audit.as(outer, async () => {
      expect(audit.current()?.actor).toEqual(outer);

      await audit.as(
        inner,
        async () => {
          expect(audit.current()).toEqual({
            actor: inner,
            context: { source: "worker" },
          });
        },
        { context: { source: "worker" } },
      );

      expect(audit.current()?.actor).toEqual(outer);
      expect(audit.current()?.context).toBeUndefined();

      await expect(
        audit.as(inner, async () => {
          expect(audit.current()?.actor).toEqual(inner);
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");

      expect(audit.current()?.actor).toEqual(outer);
    });

    expect(audit.current()).toBeUndefined();
  });

  it("preserves the actor for a lazy thenable returned unawaited from the callback", async () => {
    let executed = false;
    const createLazyQuery = (): PromiseLike<AuditScope | undefined> => ({
      // biome-ignore lint/suspicious/noThenProperty: intentional lazy PromiseLike thenable (Drizzle/Prisma query builder test)
      then<TResult1 = AuditScope | undefined, TResult2 = never>(
        onfulfilled?: ((value: AuditScope | undefined) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        executed = true;
        const captured = audit.current();
        return Promise.resolve(captured).then(onfulfilled, onrejected);
      },
    });

    const lazy = createLazyQuery();
    expect(executed).toBe(false);

    const observed = await audit.as({ type: "user", id: "usr_lazy" }, () => lazy);
    expect(executed).toBe(true);
    expect(observed).toEqual({ actor: { type: "user", id: "usr_lazy" } });
    expect(audit.current()).toBeUndefined();
  });

  it("isolates 40 concurrent scopes across timers, setImmediate and a 5-slot semaphore", async () => {
    const semaphore = new Semaphore(5);
    const scopeCount = 40;

    const tasks = Array.from({ length: scopeCount }, (_, index) => {
      const expectedId = `usr_concurrent_${index}`;
      const actor: Actor = { type: "user", id: expectedId, tenant: `org_${index % 4}` };
      const context: AuditContext = { requestId: `req_${index}`, source: "api" };

      return audit.as(
        actor,
        async () => {
          expect(audit.current()?.actor.id).toBe(expectedId);

          await new Promise<void>((resolveDelay) => {
            setTimeout(resolveDelay, (index * 7) % 19);
          });
          expect(audit.current()?.actor.id).toBe(expectedId);
          expect(audit.current()?.context?.requestId).toBe(`req_${index}`);

          await new Promise<void>((resolveImmediate) => {
            setImmediate(resolveImmediate);
          });
          expect(audit.current()?.actor.id).toBe(expectedId);

          return await semaphore.run(async () => {
            expect(audit.current()?.actor.id).toBe(expectedId);
            await new Promise<void>((resolveWork) => {
              setTimeout(resolveWork, (index * 3) % 11);
            });
            expect(audit.current()?.actor.id).toBe(expectedId);
            expect(audit.current()?.actor.tenant).toBe(`org_${index % 4}`);
            return audit.current()?.actor.id;
          });
        },
        { context },
      );
    });

    const results = await Promise.all(tasks);
    expect(results).toEqual(
      Array.from({ length: scopeCount }, (_, index) => `usr_concurrent_${index}`),
    );
    expect(audit.current()).toBeUndefined();
  });

  it("shares the same AsyncLocalStorage store across duplicated module instances", async () => {
    const contextUrl = new URL("../src/context.js", import.meta.url);
    const secondInstance = (await import(`${contextUrl.href}?dup=1`)) as {
      audit: typeof audit;
    };

    expect(secondInstance.audit).not.toBe(audit);

    const seenBySecond = await audit.as({ type: "user", id: "usr_shared_1" }, () =>
      secondInstance.audit.current(),
    );
    expect(seenBySecond).toEqual({ actor: { type: "user", id: "usr_shared_1" } });

    const seenByFirst = await secondInstance.audit.as({ type: "user", id: "usr_shared_2" }, () =>
      audit.current(),
    );
    expect(seenByFirst).toEqual({ actor: { type: "user", id: "usr_shared_2" } });
    expect(audit.current()).toBeUndefined();
  });
});

describe("AsyncLocalStorage runtime portability guard", () => {
  it("forbids enterWith() and disable() across all packages/*/src files", () => {
    const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
    const packagesDir = join(repoRoot, "packages");
    const forbiddenPattern = /\.\s*(enterWith|disable)\s*\(/;
    const violations: string[] = [];

    for (const pkgEntry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkgEntry.isDirectory()) continue;
      const srcDir = join(packagesDir, pkgEntry.name, "src");
      for (const file of collectSourceFiles(srcDir)) {
        const content = readFileSync(file, "utf8");
        if (forbiddenPattern.test(content)) {
          violations.push(file);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
