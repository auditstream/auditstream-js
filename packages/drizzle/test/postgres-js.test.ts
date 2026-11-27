import { audit, decodeScope, isTagged, tagSql } from "@auditstream/node";
import { describe, expect, it } from "vitest";
import {
  type PostgresJsLike,
  type PostgresJsTransactionLike,
  type PostgresJsUnsafeOptions,
  wrapPostgresJs,
} from "../src/postgres-js.js";

interface RecordedUnsafe {
  readonly scope: "root" | "tx" | "savepoint" | "reserved";
  readonly query: string;
  readonly parameters: readonly unknown[] | undefined;
  readonly queryOptions: PostgresJsUnsafeOptions | undefined;
}

interface FakePostgresJsTx extends PostgresJsTransactionLike {
  unsafe(
    query: string,
    parameters?: readonly unknown[] | PostgresJsUnsafeOptions,
    queryOptions?: PostgresJsUnsafeOptions,
  ): Promise<unknown[]>;
}

interface FakeReservedPostgresJs extends FakePostgresJsTx {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<string>;
  release(): void;
  begin?: (...args: never[]) => unknown;
}

interface FakePostgresJs extends PostgresJsLike {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<string>;
  unsafe(
    query: string,
    parameters?: readonly unknown[] | PostgresJsUnsafeOptions,
    queryOptions?: PostgresJsUnsafeOptions,
  ): Promise<unknown[]>;
  reserve(): Promise<FakeReservedPostgresJs>;
  readonly calls: RecordedUnsafe[];
  readonly templateCalls: string[];
  readonly beginOptions: Array<string | undefined>;
  readonly savepointNames: Array<string | undefined>;
  releaseCount: number;
  failNextReserve: Error | null;
}

function createFakePostgresJs(): FakePostgresJs {
  const calls: RecordedUnsafe[] = [];
  const templateCalls: string[] = [];
  const beginOptions: Array<string | undefined> = [];
  const savepointNames: Array<string | undefined> = [];

  // Mirrors real postgres.js unsafe(string, args = [], options = {}) runtime behavior:
  // - 2 args with non-array 2nd arg: treats 2nd arg as options, args = []
  // - invalid null/primitive options: throws TypeError synchronously (`'simple' in options`)
  // - 3 args with non-array 2nd arg: rejects asynchronously
  const recordUnsafe = (
    scope: RecordedUnsafe["scope"],
    query: string,
    ...rest: unknown[]
  ): Promise<unknown[]> => {
    const firstArg = rest[0];
    let parameters: readonly unknown[] | undefined;
    let queryOptions = rest[1] as PostgresJsUnsafeOptions | undefined;

    if (rest.length === 1 && firstArg !== undefined && !Array.isArray(firstArg)) {
      queryOptions = firstArg as PostgresJsUnsafeOptions;
      parameters = [];
    } else if (firstArg !== undefined && !Array.isArray(firstArg)) {
      if (queryOptions !== undefined) {
        void ("simple" in (queryOptions as object));
      }
      return Promise.reject(new TypeError("q.args.forEach is not a function"));
    } else {
      parameters = firstArg;
    }

    if (queryOptions !== undefined) {
      // Mirrors postgres.js `'simple' in options` check (throws TypeError on null/primitives).
      void ("simple" in (queryOptions as object));
    }

    calls.push({ scope, query, parameters, queryOptions });
    return Promise.resolve([]);
  };

  const makeTx = (scope: "tx" | "savepoint"): PostgresJsTransactionLike => {
    const tx: PostgresJsTransactionLike = {
      unsafe(query: string, ...rest: unknown[]) {
        return recordUnsafe(scope, query, ...rest);
      },
      savepoint(...args: unknown[]) {
        const first = args[0];
        const rawArr =
          (typeof first === "object" || typeof first === "function") && first !== null
            ? (first as { raw?: unknown }).raw
            : undefined;
        if (Array.isArray(rawArr)) {
          templateCalls.push(`savepoint:${rawArr.join("?")}`);
          return Promise.resolve(args.slice(1));
        }
        const isOneArg = args.length === 1;
        const name = isOneArg ? undefined : (first as string | undefined);
        const cb = (isOneArg ? first : args[1]) as (sp: PostgresJsTransactionLike) => unknown;
        savepointNames.push(name);
        return Promise.resolve(cb(makeTx("savepoint")));
      },
    };
    return tx;
  };

  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    templateCalls.push(`${strings.join("?")}:${values.join(",")}`);
    return Promise.resolve("template-ok");
  }) as FakePostgresJs;

  const invokeBegin = (...args: unknown[]): Promise<unknown> => {
    const hasCbSecond = typeof args[1] === "function";
    const opts = hasCbSecond ? (args[0] as string) : undefined;
    const cb = (hasCbSecond ? args[1] : args[0]) as (tx: PostgresJsTransactionLike) => unknown;
    beginOptions.push(opts);
    return Promise.resolve(cb(makeTx("tx")));
  };

  const makeReserved = (): FakeReservedPostgresJs => {
    const reserved = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      templateCalls.push(`reserved:${strings.join("?")}:${values.join(",")}`);
      return Promise.resolve("reserved-template-ok");
    }) as FakeReservedPostgresJs;

    Object.assign(reserved, {
      unsafe(query: string, ...rest: unknown[]) {
        return recordUnsafe("reserved", query, ...rest);
      },
      release() {
        fn.releaseCount += 1;
      },
      begin: invokeBegin,
    });
    return reserved;
  };

  Object.assign(fn, {
    calls,
    templateCalls,
    beginOptions,
    savepointNames,
    releaseCount: 0,
    failNextReserve: null as Error | null,
    unsafe(query: string, ...rest: unknown[]) {
      return recordUnsafe("root", query, ...rest);
    },
    begin: invokeBegin,
    reserve() {
      if (fn.failNextReserve !== null) {
        const err = fn.failNextReserve;
        fn.failNextReserve = null;
        return Promise.reject(err);
      }
      return Promise.resolve(makeReserved());
    },
  });

  return fn;
}

describe("wrapPostgresJs()", () => {
  it("is idempotent when called twice on the same wrapped client", () => {
    const raw = createFakePostgresJs();
    const wrappedOnce = wrapPostgresJs(raw);
    const wrappedTwice = wrapPostgresJs(wrappedOnce);
    expect(wrappedTwice).toBe(wrappedOnce);
  });

  it("tags unsafe() inside a scope, forces prepare: false without mutating caller options, and preserves other options", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);

    const callerOptions: PostgresJsUnsafeOptions = { prepare: true, simple: false };

    await audit.as({ type: "user", id: "usr_1" }, async () => {
      await sql.unsafe("UPDATE invoice SET status = $1 WHERE id = $2", ["paid", 7], callerOptions);
    });

    expect(callerOptions.prepare).toBe(true);
    expect(raw.calls).toHaveLength(1);
    const call = raw.calls[0];
    expect(call?.scope).toBe("root");
    expect(isTagged(call?.query ?? "")).toBe(true);
    expect(decodeScope(call?.query ?? "").actor).toEqual({ type: "user", id: "usr_1" });
    expect(call?.parameters).toEqual(["paid", 7]);
    expect(call?.queryOptions).toEqual({ prepare: false, simple: false });
  });

  it("leaves untagged calls intact and forces prepare: false on pre-tagged SQL without double-tagging", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);
    const opts: PostgresJsUnsafeOptions = { prepare: true, simple: false };

    // Outside any scope, untagged: 1-arg, 2-arg params, and 3-arg calls stay untouched.
    await sql.unsafe("SELECT 0");
    await sql.unsafe("SELECT $1", [1]);
    await sql.unsafe("SELECT 1", [], opts);

    // Already tagged SQL (for example from Drizzle 1.x .comment()): not double-tagged,
    // but prepare: false is enforced both inside and outside an active scope.
    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "pre_tagged" },
    });
    await audit.as({ type: "user", id: "outer_user" }, async () => {
      await sql.unsafe(preTagged, ["done"], opts);
    });
    await sql.unsafe(preTagged, ["outside"], opts);
    await sql.unsafe(preTagged);

    expect(opts.prepare).toBe(true);
    expect(raw.calls).toHaveLength(6);
    expect(raw.calls[0]?.query).toBe("SELECT 0");
    expect(raw.calls[0]?.parameters).toBeUndefined();
    expect(raw.calls[0]?.queryOptions).toBeUndefined();

    expect(raw.calls[1]?.query).toBe("SELECT $1");
    expect(raw.calls[1]?.parameters).toEqual([1]);
    expect(raw.calls[1]?.queryOptions).toBeUndefined();

    expect(raw.calls[2]?.query).toBe("SELECT 1");
    expect(raw.calls[2]?.queryOptions).toBe(opts);

    expect(raw.calls[3]?.query).toBe(preTagged);
    expect(raw.calls[3]?.parameters).toEqual(["done"]);
    expect(raw.calls[3]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[4]?.query).toBe(preTagged);
    expect(raw.calls[4]?.parameters).toEqual(["outside"]);
    expect(raw.calls[4]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[5]?.query).toBe(preTagged);
    expect(raw.calls[5]?.queryOptions).toEqual({ prepare: false });
  });

  it("supports the 2-argument sql.unsafe(query, options) overload without crashing", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);
    const callerOpts: PostgresJsUnsafeOptions = { prepare: true, simple: false };

    // Inside a scope: 2-arg (query, options) tags cleanly, enforces prepare: false, preserves simple.
    await audit.as({ type: "user", id: "usr_two_arg" }, async () => {
      await sql.unsafe("UPDATE invoice SET status = 'paid' WHERE id = 1", callerOpts);
    });

    // Pre-tagged SQL with 2-arg (query, options) both outside and inside an active scope.
    const preTagged = tagSql("UPDATE invoice SET status = 'void' WHERE id = 2", {
      actor: { type: "service", id: "svc_pre" },
    });
    await sql.unsafe(preTagged, callerOpts);
    await audit.as({ type: "user", id: "usr_outer_two_arg" }, async () => {
      await sql.unsafe(preTagged, callerOpts);
    });

    // Outside any scope, untagged 2-arg (query, options): preserves prepare: true.
    await sql.unsafe("SELECT 1", callerOpts);

    // Explicit undefined parameters (2-arg and 3-arg) continue to work cleanly.
    await audit.as({ type: "user", id: "usr_undef" }, async () => {
      await sql.unsafe("UPDATE invoice SET status = 'u1'", undefined);
      await sql.unsafe("UPDATE invoice SET status = 'u2'", undefined, callerOpts);
    });

    expect(callerOpts.prepare).toBe(true);
    expect(raw.calls).toHaveLength(6);

    expect(isTagged(raw.calls[0]?.query ?? "")).toBe(true);
    expect(decodeScope(raw.calls[0]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_two_arg",
    });
    expect(raw.calls[0]?.parameters).toEqual([]);
    expect(raw.calls[0]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[1]?.query).toBe(preTagged);
    expect(raw.calls[1]?.parameters).toEqual([]);
    expect(raw.calls[1]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[2]?.query).toBe(preTagged);
    expect(raw.calls[2]?.parameters).toEqual([]);
    expect(raw.calls[2]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[3]?.query).toBe("SELECT 1");
    expect(raw.calls[3]?.parameters).toEqual([]);
    expect(raw.calls[3]?.queryOptions).toEqual({ prepare: true, simple: false });

    expect(decodeScope(raw.calls[4]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_undef",
    });
    expect(raw.calls[4]?.queryOptions).toEqual({ prepare: false });

    expect(decodeScope(raw.calls[5]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_undef",
    });
    expect(raw.calls[5]?.queryOptions).toEqual({ prepare: false, simple: false });
  });

  it("preserves postgres.js options semantics (frozen, null-proto, inherited simple, and invalid primitives)", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);

    // Prototype-inherited `simple: false` and `prepare: true`: preserves `simple: false`, forces `prepare: false`.
    const inheritedOpts = Object.create({
      simple: false,
      prepare: true,
    }) as PostgresJsUnsafeOptions;
    // Frozen options object.
    const frozenOpts = Object.freeze({ prepare: true, simple: false });
    // Null-prototype options object.
    const nullProtoOpts = Object.assign(Object.create(null) as Record<string, unknown>, {
      prepare: true,
      simple: false,
    }) as PostgresJsUnsafeOptions;

    await audit.as({ type: "user", id: "usr_opts_edge" }, async () => {
      await sql.unsafe("UPDATE invoice SET status = 'inh'", inheritedOpts);
      await sql.unsafe("UPDATE invoice SET status = 'frz'", frozenOpts);
      await sql.unsafe("UPDATE invoice SET status = 'np'", nullProtoOpts);
    });

    expect(raw.calls).toHaveLength(3);
    expect(raw.calls[0]?.queryOptions).toEqual({ prepare: false, simple: false });
    expect(raw.calls[1]?.queryOptions).toEqual({ prepare: false, simple: false });
    expect(raw.calls[2]?.queryOptions).toEqual({ prepare: false, simple: false });

    // Invalid primitive/null options throw synchronously, matching real postgres.js.
    const rawUnsafeAny = sql.unsafe as unknown as (...args: unknown[]) => unknown;
    await audit.as({ type: "user", id: "usr_bad_opts" }, () => {
      expect(() => rawUnsafeAny("SELECT 1", 42)).toThrow(TypeError);
      expect(() => rawUnsafeAny("SELECT 1", null)).toThrow(TypeError);
      expect(() => rawUnsafeAny("SELECT 1", [], null)).toThrow(TypeError);
    });

    // 3-arg (query, optionsObj, undefined) preserves arity failure across untagged, scoped, and pre-tagged paths.
    const preTaggedArity = tagSql("UPDATE invoice SET status = 'x'", {
      actor: { type: "service", id: "arity_svc" },
    });
    await expect(
      rawUnsafeAny("SELECT 1", { prepare: true }, undefined) as Promise<unknown>,
    ).rejects.toThrow(TypeError);
    await audit.as({ type: "user", id: "usr_arity" }, async () => {
      await expect(
        rawUnsafeAny(
          "UPDATE invoice SET status = 'x'",
          { prepare: true },
          undefined,
        ) as Promise<unknown>,
      ).rejects.toThrow(TypeError);
    });
    await expect(
      rawUnsafeAny(preTaggedArity, { prepare: true }, undefined) as Promise<unknown>,
    ).rejects.toThrow(TypeError);

    // Non-string queries pass through to postgres.js without crashing inside isTagged().
    await rawUnsafeAny(null);
    await rawUnsafeAny(undefined);
    await rawUnsafeAny(Symbol("s"));
  });

  it("wraps begin/savepoint with trailing undefined args, skips template savepoints, and handles thenable reserve()", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);
    const markerFn = () => "not-a-callback";

    await audit.as({ type: "user", id: "usr_trailing" }, async () => {
      await (
        sql.begin as (
          cb: (tx: FakePostgresJsTx) => Promise<void>,
          extra?: undefined,
        ) => Promise<void>
      )(async (tx) => {
        await tx.unsafe("UPDATE invoice SET status = $1", ["b1"], { prepare: true });
        await (
          tx.savepoint as (
            name: string,
            cb: (sp: FakePostgresJsTx) => Promise<void>,
            extra?: undefined,
          ) => Promise<void>
        )(
          "sp_trailing",
          async (sp) => {
            await sp.unsafe("UPDATE invoice SET status = $1", ["sp1"], { prepare: true });
          },
          undefined,
        );
        // Tagged-template savepoint whose interpolated value is a function must not wrap that function.
        const interpolated = await (tx.savepoint as (
          strings: TemplateStringsArray,
          ...vals: unknown[]
        ) => Promise<unknown[]>)`SELECT ${markerFn}`;
        expect(interpolated).toEqual([markerFn]);

        // Synthetic template object `{ raw: [...] }` matches postgres.js `Array.isArray(name.raw)`.
        const synthetic = await (
          tx.savepoint as (strings: { raw: string[] }, val: unknown) => Promise<unknown[]>
        )({ raw: ["SELECT ", ""] }, markerFn);
        expect(synthetic).toEqual([markerFn]);
      }, undefined);

      await (
        sql.begin as (
          opts: string,
          cb: (tx: FakePostgresJsTx) => Promise<void>,
          extra?: undefined,
        ) => Promise<void>
      )(
        "read write",
        async (tx) => {
          await tx.unsafe("UPDATE invoice SET status = $1", ["b2"], { prepare: true });
        },
        undefined,
      );
    });

    expect(raw.calls).toHaveLength(3);
    for (const call of raw.calls) {
      expect(decodeScope(call.query).actor).toEqual({ type: "user", id: "usr_trailing" });
      expect(call.queryOptions).toEqual({ prepare: false });
    }

    // Non-chainable (void-returning) custom PromiseLike thenable returned by reserve():
    // wraps the resolved client and propagates rejections cleanly.
    const reservedTarget = await raw.reserve();
    const thenableSql = {
      unsafe: raw.unsafe.bind(raw),
      begin: raw.begin.bind(raw),
      reserve: () => ({
        // biome-ignore lint/suspicious/noThenProperty: intentionally testing non-chainable custom thenable
        then(onFulfilled: (r: FakeReservedPostgresJs) => void) {
          queueMicrotask(() => onFulfilled(reservedTarget));
        },
      }),
    };
    const wrappedThenable = wrapPostgresJs(thenableSql);
    const wrappedRes = await (
      wrappedThenable.reserve as unknown as () => Promise<FakeReservedPostgresJs>
    )();
    await audit.as({ type: "user", id: "usr_thenable" }, async () => {
      await wrappedRes.unsafe("UPDATE invoice SET status = 'th'", { prepare: true });
    });
    expect(decodeScope(raw.calls.at(-1)?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_thenable",
    });

    const rejectingReserveSql = {
      unsafe: raw.unsafe.bind(raw),
      begin: raw.begin.bind(raw),
      reserve: () => ({
        // biome-ignore lint/suspicious/noThenProperty: intentionally testing rejecting PromiseLike thenable
        then(_onFulfilled: unknown, onRejected: (err: Error) => void) {
          queueMicrotask(() => onRejected(new Error("thenable reserve failed")));
        },
      }),
    };
    const wrappedRejectingReserve = wrapPostgresJs(rejectingReserveSql);
    await expect((wrappedRejectingReserve.reserve as () => Promise<unknown>)()).rejects.toThrow(
      "thenable reserve failed",
    );

    // Nested thenable assimilation (thenable resolving to Promise.resolve(reserved)) wraps the inner reserved client.
    const nestedReserveSql = {
      unsafe: raw.unsafe.bind(raw),
      begin: raw.begin.bind(raw),
      reserve: () => ({
        // biome-ignore lint/suspicious/noThenProperty: intentionally testing nested thenable assimilation
        then(onFulfilled: (r: Promise<FakeReservedPostgresJs>) => void) {
          onFulfilled(Promise.resolve(reservedTarget));
        },
      }),
    };
    const wrappedNestedReserve = wrapPostgresJs(nestedReserveSql);
    const nestedRes = await (
      wrappedNestedReserve.reserve as unknown as () => Promise<FakeReservedPostgresJs>
    )();
    await audit.as({ type: "user", id: "usr_nested_res" }, async () => {
      await nestedRes.unsafe("UPDATE invoice SET status = 'nested_res'", { prepare: true });
    });
    expect(decodeScope(raw.calls.at(-1)?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_nested_res",
    });
    expect(raw.calls.at(-1)?.queryOptions).toEqual({ prepare: false });

    // Single-read getter on reserve/begin/savepoint prevents TOCTOU and extra getter evaluation.
    let reserveReads = 0;
    const toctouClient = {
      unsafe: raw.unsafe.bind(raw),
      begin: raw.begin.bind(raw),
      get reserve(): (() => Promise<FakeReservedPostgresJs>) | undefined {
        reserveReads += 1;
        return reserveReads === 1 ? undefined : raw.reserve.bind(raw);
      },
    };
    const wrappedToctou = wrapPostgresJs(toctouClient);
    expect(wrappedToctou.reserve).toBeUndefined();
    expect(reserveReads).toBe(1);
  });

  it("handles synchronous reserve() returns, exactOptionalPropertyTypes clients, and defensive non-object guards", async () => {
    const raw = createFakePostgresJs();
    const reservedSync = await raw.reserve();
    const syncSql: {
      unsafe: FakePostgresJs["unsafe"];
      begin: FakePostgresJs["begin"];
      reserve?: (() => FakeReservedPostgresJs) | undefined;
    } = {
      unsafe: raw.unsafe.bind(raw),
      begin: raw.begin.bind(raw),
      reserve: () => reservedSync,
    };
    const wrapped = wrapPostgresJs(syncSql);
    const res = wrapped.reserve?.();
    expect(res).toBeDefined();

    await audit.as({ type: "user", id: "usr_sync_res" }, async () => {
      await res?.unsafe("UPDATE invoice SET status = 'sync'", { prepare: true });
    });

    expect(raw.calls).toHaveLength(1);
    expect(raw.calls[0]?.scope).toBe("reserved");
    expect(decodeScope(raw.calls[0]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_sync_res",
    });
    expect(raw.calls[0]?.queryOptions).toEqual({ prepare: false });
    expect(wrapPostgresJs(null as unknown as PostgresJsLike)).toBeNull();
  });

  it("proxies sql.reserve() so reserved connections tag writes, disable prepare, and preserve release() and templates", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);
    const callerOpts: PostgresJsUnsafeOptions = { prepare: true, simple: false };

    const reserved = await sql.reserve();
    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "svc_res_pre" },
    });
    try {
      // Idempotent when passed to wrapPostgresJs() again.
      expect(wrapPostgresJs(reserved as unknown as PostgresJsLike)).toBe(reserved);

      // Tagged writes across multiple scopes (3-arg and 2-arg overloads).
      await audit.as({ type: "user", id: "usr_res_1" }, async () => {
        await reserved.unsafe("UPDATE invoice SET status = $1 WHERE id = $2", ["a", 1], callerOpts);
        await reserved.unsafe("UPDATE invoice SET status = 'b' WHERE id = 2", callerOpts);
      });
      await audit.as({ type: "user", id: "usr_res_2" }, async () => {
        await reserved.unsafe("UPDATE invoice SET status = $1 WHERE id = $2", ["c", 3]);
      });

      // Pre-tagged outside any scope still enforces prepare: false.
      await reserved.unsafe(preTagged, ["d"], callerOpts);

      // Untagged outside any scope preserves caller options.
      await reserved.unsafe("SELECT 1", [], callerOpts);

      // Tagged templates on reserved connection pass through untouched.
      const tpl = await audit.as({ type: "user", id: "usr_res_tpl" }, () => reserved`SELECT ${7}`);
      expect(tpl).toBe("reserved-template-ok");

      // Nested begin() on a reserved client (if present) also wraps its transaction callback.
      await audit.as({ type: "user", id: "usr_res_tx" }, async () => {
        await (reserved.begin as (cb: (tx: FakePostgresJsTx) => Promise<void>) => Promise<void>)(
          async (tx) => {
            await tx.unsafe("UPDATE invoice SET status = $1", ["tx_res"], callerOpts);
          },
        );
      });
    } finally {
      reserved.release();
    }

    expect(callerOpts.prepare).toBe(true);
    expect(raw.releaseCount).toBe(1);
    expect(raw.templateCalls).toEqual(["reserved:SELECT ?:7"]);
    expect(raw.calls).toHaveLength(6);

    expect(raw.calls[0]?.scope).toBe("reserved");
    expect(decodeScope(raw.calls[0]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_res_1",
    });
    expect(raw.calls[0]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[1]?.scope).toBe("reserved");
    expect(decodeScope(raw.calls[1]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_res_1",
    });
    expect(raw.calls[1]?.parameters).toEqual([]);
    expect(raw.calls[1]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[2]?.scope).toBe("reserved");
    expect(decodeScope(raw.calls[2]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_res_2",
    });
    expect(raw.calls[2]?.queryOptions).toEqual({ prepare: false });

    expect(raw.calls[3]?.scope).toBe("reserved");
    expect(raw.calls[3]?.query).toBe(preTagged);
    expect(raw.calls[3]?.queryOptions).toEqual({ prepare: false, simple: false });

    expect(raw.calls[4]?.scope).toBe("reserved");
    expect(raw.calls[4]?.query).toBe("SELECT 1");
    expect(raw.calls[4]?.queryOptions).toBe(callerOpts);

    expect(raw.calls[5]?.scope).toBe("tx");
    expect(decodeScope(raw.calls[5]?.query ?? "").actor).toEqual({
      type: "user",
      id: "usr_res_tx",
    });
    expect(raw.calls[5]?.queryOptions).toEqual({ prepare: false, simple: false });

    // Rejections from sql.reserve() propagate cleanly.
    raw.failNextReserve = new Error("pool exhausted");
    await expect(sql.reserve()).rejects.toThrow("pool exhausted");
  });

  it("wraps begin(cb), begin(options, cb), savepoint(cb), and savepoint(name, cb) recursively", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);

    await audit.as({ type: "user", id: "tx_actor" }, async () => {
      await (sql.begin as (cb: (tx: FakePostgresJsTx) => Promise<void>) => Promise<void>)(
        async (tx) => {
          await tx.unsafe("UPDATE invoice SET status = $1", ["tx1"], { prepare: true });
          await (tx.savepoint as (cb: (sp: FakePostgresJsTx) => Promise<void>) => Promise<void>)(
            async (sp) => {
              await sp.unsafe("DELETE FROM line_item WHERE id = $1", [10]);
              await (
                sp.savepoint as (
                  name: string,
                  cb: (sp2: FakePostgresJsTx) => Promise<void>,
                ) => Promise<void>
              )("sp_inner", async (sp2) => {
                await sp2.unsafe("INSERT INTO invoice VALUES ($1)", [99], { prepare: true });
              });
            },
          );
        },
      );

      await (
        sql.begin as (opts: string, cb: (tx: FakePostgresJsTx) => Promise<void>) => Promise<void>
      )("read write", async (tx) => {
        await tx.unsafe("UPDATE invoice SET status = $1", ["tx2"]);
      });
    });

    expect(raw.beginOptions).toEqual([undefined, "read write"]);
    expect(raw.savepointNames).toEqual([undefined, "sp_inner"]);
    expect(raw.calls).toHaveLength(4);
    for (const call of raw.calls) {
      expect(isTagged(call.query)).toBe(true);
      expect(decodeScope(call.query).actor).toEqual({ type: "user", id: "tx_actor" });
      expect(call.queryOptions?.prepare).toBe(false);
    }
  });

  it("passes tagged-template calls through untouched", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);

    const res = await audit.as({ type: "user", id: "tpl_user" }, () => sql`SELECT ${42}`);
    expect(res).toBe("template-ok");
    expect(raw.templateCalls).toEqual(["SELECT ?:42"]);
    expect(raw.calls).toHaveLength(0);
  });
});
