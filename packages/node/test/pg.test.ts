import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { audit, decodeScope, isTagged, tagSql } from "../src/index.js";
import { type PgClientLike, type PgPoolLike, type PgQueryConfig, wrapPgPool } from "../src/pg.js";

interface RecordedQuery {
  readonly text: string | undefined;
  readonly values: unknown;
  readonly name: string | undefined;
  readonly raw: unknown;
}

class FakeClient implements PgClientLike {
  public readonly queries: RecordedQuery[] = [];
  public readonly connection = { id: "fake-conn" };
  public activeQuery: unknown = null;
  public readonly cancelledQueries: unknown[] = [];

  public cancel(client: FakeClient, query: unknown): boolean {
    if (client.activeQuery === query) {
      this.cancelledQueries.push(query);
      return true;
    }
    return false;
  }

  public query<T extends { submit: (...args: never[]) => unknown }>(first: T): T;
  public query(first: unknown, second?: unknown): Promise<{ rows: unknown[] }>;
  public query(first: unknown, second: (err: unknown, res: { rows: unknown[] }) => void): void;
  public query(
    first: unknown,
    second: unknown,
    third: (err: unknown, res: { rows: unknown[] }) => void,
  ): void;
  public query(
    first: unknown,
    second?: unknown,
    third?: unknown,
  ): Promise<{ rows: unknown[] }> | unknown {
    const cb =
      typeof second === "function" ? second : typeof third === "function" ? third : undefined;
    if (typeof first === "string") {
      this.queries.push({
        text: first,
        values: typeof second === "function" ? undefined : second,
        name: undefined,
        raw: first,
      });
    } else if ((typeof first === "object" || typeof first === "function") && first !== null) {
      // Mirror real pg/lib/client.js:677-686 & 784: submittables (object OR callable) invoke
      // `.submit(connection)` with `this = config` and return `config` when no callback is given.
      if (typeof (first as { submit?: unknown }).submit === "function") {
        this.activeQuery = first;
        (first as { submit: (conn: unknown) => void }).submit(this.connection);
        const cfg = first as PgQueryConfig;
        this.queries.push({
          text: typeof cfg.text === "string" ? cfg.text : undefined,
          values: second && typeof second !== "function" ? second : cfg.values,
          name: cfg.name,
          raw: first,
        });
        if (cb) {
          cb(null, { rows: [] });
          return;
        }
        return first;
      }
      const cfg = first as PgQueryConfig;
      this.queries.push({
        text: cfg.text,
        // Mirror pg/lib/utils.js normalizeQueryConfig: a truthy non-function 2nd arg overwrites cfg.values.
        values: second && typeof second !== "function" ? second : cfg.values,
        name: cfg.name,
        raw: first,
      });
    }

    if (cb) {
      cb(null, { rows: [] });
      return;
    }
    return Promise.resolve({ rows: [] });
  }
}

/**
 * Fake pool matching pg-pool's exact queuing behavior: when the single client is busy,
 * pending connect() callbacks are stored and later resumed synchronously inside whichever
 * async context releases the connection.
 */
class FakeQueuingPool extends EventEmitter implements PgPoolLike {
  public readonly client = new FakeClient();
  private busy = false;
  private readonly waiters: Array<
    (err: Error | null, client: FakeClient, done: () => void) => void
  > = [];
  private connectedOnce = false;
  public failNextConnect: Error | null = null;
  public lastQueryThirdArg: unknown = undefined;

  public connect(): Promise<FakeClient>;
  public connect(cb: (err: Error | null, client: FakeClient, done: () => void) => void): void;
  public connect(
    cb?: (err: Error | null, client: FakeClient, done: () => void) => void,
  ): Promise<FakeClient> | undefined {
    const dispatch = (
      fn: (err: Error | null, client: FakeClient, done: () => void) => void,
    ): void => {
      if (this.failNextConnect !== null) {
        const err = this.failNextConnect;
        this.failNextConnect = null;
        fn(err, undefined as unknown as FakeClient, () => undefined);
        return;
      }
      if (!this.connectedOnce) {
        this.connectedOnce = true;
        this.emit("connect", this.client);
      }
      if (!this.busy) {
        this.busy = true;
        fn(null, this.client, () => this.release());
      } else {
        this.waiters.push(fn);
      }
    };

    if (cb) {
      dispatch(cb);
      return;
    }
    return new Promise((resolve, reject) => {
      dispatch((err, client) => {
        if (err) reject(err);
        else resolve(client);
      });
    });
  }

  public release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Intentionally invoke the queued waiter inside the releaser's current AsyncLocalStorage scope!
      next(null, this.client, () => this.release());
    } else {
      this.busy = false;
    }
  }

  public query(first: unknown, second?: unknown): Promise<{ rows: unknown[] }>;
  public query(first: unknown, second: (err: unknown, res: { rows: unknown[] }) => void): void;
  public query(
    first: unknown,
    second: unknown,
    third: (err: unknown, res: { rows: unknown[] }) => void,
  ): void;
  public query(
    first: unknown,
    second?: unknown,
    third?: unknown,
  ): Promise<{ rows: unknown[] }> | undefined {
    this.lastQueryThirdArg = third;
    // Mirror pg-pool/index.js:433 & promisify(): passing a function as the first parameter
    // treats it as the callback, invokes it asynchronously with an Error, and returns undefined.
    if (typeof first === "function") {
      queueMicrotask(() => {
        (first as (err: Error) => void)(
          new Error("Passing a function as the first parameter to pool.query is not supported"),
        );
      });
      return undefined;
    }

    const cb =
      typeof second === "function" ? second : typeof third === "function" ? third : undefined;
    const values = typeof second === "function" ? undefined : second;

    if (cb) {
      this.connect((err, client, done) => {
        if (err) {
          cb(err);
          return;
        }
        client.query(first, values, (qErr: unknown, res: unknown) => {
          done();
          cb(qErr, res);
        });
      });
      return;
    }

    return new Promise((resolve, reject) => {
      this.connect((err, client, done) => {
        if (err) {
          reject(err);
          return;
        }
        client.query(first, values, (qErr: unknown, res: unknown) => {
          done();
          if (qErr) reject(qErr);
          else resolve(res as { rows: unknown[] });
        });
      });
    });
  }
}

describe("wrapPgPool()", () => {
  it("returns the same pool and is idempotent when wrapped twice", async () => {
    const pool = new FakeQueuingPool();
    const wrappedOnce = wrapPgPool(pool);
    const wrappedTwice = wrapPgPool(wrappedOnce);

    expect(wrappedOnce).toBe(pool);
    expect(wrappedTwice).toBe(pool);
    expect(pool.listenerCount("connect")).toBe(1);

    await audit.as({ type: "user", id: "usr_once" }, async () => {
      await pool.query("SELECT 1");
    });

    expect(pool.client.queries).toHaveLength(1);
    const text = pool.client.queries[0]?.text ?? "";
    expect(isTagged(text)).toBe(true);
    expect(text.match(/auditstream=/g)).toHaveLength(1);
    expect(decodeScope(text).actor).toEqual({ type: "user", id: "usr_once" });
  });

  it("supports string, { text, values }, and callback call forms", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());

    await audit.as({ type: "user", id: "usr_forms" }, async () => {
      await pool.query("SELECT $1::int", [1]);
      await pool.query({ text: "SELECT $1::text", values: ["hello"] });
      await new Promise<void>((resolve, reject) => {
        pool.query("SELECT 2", (err: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        pool.query("SELECT $1::int", [3], (err: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    expect(pool.client.queries).toHaveLength(4);
    for (const q of pool.client.queries) {
      expect(decodeScope(q.text ?? "").actor).toEqual({ type: "user", id: "usr_forms" });
    }
    expect(pool.client.queries[0]?.values).toEqual([1]);
    expect(pool.client.queries[1]?.values).toEqual(["hello"]);
    expect(pool.client.queries[3]?.values).toEqual([3]);
  });

  it("adds at most one tag, drops name whenever a query carries a tag, and keeps caller config unmutated", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());

    const originalConfig: PgQueryConfig = {
      text: "UPDATE invoice SET status = $1 WHERE id = $2",
      values: ["paid", 1],
      name: "upd1",
    };

    // Tagged: drops `name` on shallow copy, leaves originalConfig intact.
    await audit.as({ type: "user", id: "usr_prep" }, async () => {
      await pool.query(originalConfig);
    });
    expect(originalConfig.name).toBe("upd1");
    expect(isTagged(originalConfig.text)).toBe(false);
    expect(pool.client.queries[0]?.name).toBeUndefined();
    expect(decodeScope(pool.client.queries[0]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_prep",
    });

    // Already tagged (e.g. Drizzle 1.x .comment()): never double-tagged, and drops `name`.
    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "user", id: "usr_drizzle_comment" },
    });
    const preTaggedConfig: PgQueryConfig = {
      text: preTagged,
      values: ["open"],
      name: "pre_upd",
      rowMode: "array",
    };
    await audit.as({ type: "user", id: "usr_outer" }, async () => {
      await pool.query(preTaggedConfig);
    });
    expect(preTaggedConfig.name).toBe("pre_upd");
    expect(pool.client.queries[1]?.text).toBe(preTagged);
    expect(pool.client.queries[1]?.name).toBeUndefined();
    expect((pool.client.queries[1]?.raw as PgQueryConfig | undefined)?.rowMode).toBe("array");

    // Pre-tagged outside any scope: still drops `name` without mutating caller config.
    await pool.query(preTaggedConfig);
    expect(preTaggedConfig.name).toBe("pre_upd");
    expect(pool.client.queries[2]?.text).toBe(preTagged);
    expect(pool.client.queries[2]?.name).toBeUndefined();

    // Untagged (outside any scope): preserves `name`.
    await pool.query(originalConfig);
    expect(pool.client.queries[3]?.name).toBe("upd1");
    expect(isTagged(pool.client.queries[3]?.text ?? "")).toBe(false);
  });

  it("drops name on pre-tagged queries on checked-out clients (inside and outside a scope)", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const client = await pool.connect();

    const preTagged = tagSql("UPDATE invoice SET status = $1 WHERE id = $2", {
      actor: { type: "service", id: "pre_tx" },
    });
    const cfg: PgQueryConfig = { text: preTagged, name: "drizzle_v1_prep" };

    // Inside a scope, with Drizzle 1.x's (config, params) two-arg call shape.
    await audit.as({ type: "user", id: "usr_outer" }, async () => {
      await client.query(cfg, ["paid", 1]);
    });

    // Outside any scope.
    await client.query(cfg, ["void", 2]);
    pool.release();

    expect(cfg.name).toBe("drizzle_v1_prep");
    expect(pool.client.queries).toHaveLength(2);
    expect(pool.client.queries[0]?.text).toBe(preTagged);
    expect(pool.client.queries[0]?.name).toBeUndefined();
    expect(pool.client.queries[0]?.values).toEqual(["paid", 1]);
    expect(pool.client.queries[1]?.text).toBe(preTagged);
    expect(pool.client.queries[1]?.name).toBeUndefined();
    expect(pool.client.queries[1]?.values).toEqual(["void", 2]);
  });

  it("preserves prototype-inherited fields, handles frozen/null-prototype configs, prepared-only configs, and one-shot pool decisions", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "proto_pre" },
    });

    // 1. Plain config removes `name` completely from the cloned config.
    await pool.query({ text: preTagged, values: ["plain"], name: "plain_stmt" });
    const plainForwarded = pool.client.queries[0]?.raw as PgQueryConfig;
    expect(plainForwarded.name).toBeUndefined();
    expect("name" in plainForwarded).toBe(false);

    // 2. Prototype-inherited text, name, and rowMode: shadows inherited `name` as non-enumerable undefined.
    const inheritedPreTagged = Object.create({
      text: preTagged,
      name: "proto_stmt",
      rowMode: "array",
    }) as PgQueryConfig;
    await pool.query(inheritedPreTagged);
    const inheritedForwarded = pool.client.queries[1]?.raw as PgQueryConfig;
    expect(pool.client.queries[1]?.text).toBe(preTagged);
    expect(pool.client.queries[1]?.name).toBeUndefined();
    expect(Object.keys(inheritedForwarded)).not.toContain("name");
    expect(inheritedForwarded.rowMode).toBe("array");

    // 3. Frozen config (must not throw and must not mutate caller).
    const frozen = Object.freeze({
      text: preTagged,
      values: ["frozen"],
      name: "frozen_stmt",
    });
    await pool.query(frozen);
    expect(frozen.name).toBe("frozen_stmt");
    expect(pool.client.queries[2]?.text).toBe(preTagged);
    expect(pool.client.queries[2]?.name).toBeUndefined();

    // 4. Null-prototype config.
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, {
      text: "UPDATE invoice SET status = 'np'",
      name: "np_stmt",
    }) as PgQueryConfig;
    await audit.as({ type: "user", id: "usr_np" }, async () => {
      await pool.query(nullProto);
    });
    expect(Object.getPrototypeOf(pool.client.queries[3]?.raw)).toBeNull();
    expect(pool.client.queries[3]?.name).toBeUndefined();
    expect(decodeScope(pool.client.queries[3]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_np",
    });

    // 5. Prepared-only `{ name, values }` configs (no string `text`) pass through with `name` intact.
    await pool.query({ name: "already_prepared", values: ["x"] } as unknown as PgQueryConfig);
    await pool.query({ text: null, name: "null_prepared_stmt" } as unknown as PgQueryConfig);
    expect(pool.client.queries[4]?.name).toBe("already_prepared");
    expect(pool.client.queries[5]?.name).toBe("null_prepared_stmt");

    // 6. One-shot `decidedPoolConfigs`: reusing a forwarded config on client.query() inside a scope still tags it.
    await pool.query({ text: "UPDATE invoice SET status = 'reuse'", name: "reuse_stmt" });
    const reusedCfg = pool.client.queries[6]?.raw as PgQueryConfig;
    expect(isTagged(reusedCfg.text)).toBe(false);
    const client = await pool.connect();
    await audit.as({ type: "user", id: "usr_reuse" }, async () => {
      await client.query(reusedCfg);
      await client.query("UPDATE invoice SET status = $1", ["tx_str"]);
    });
    pool.release();
    expect(decodeScope(pool.client.queries[7]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_reuse",
    });
    expect(pool.client.queries[7]?.name).toBeUndefined();
    expect(decodeScope(pool.client.queries[8]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_reuse",
    });
    expect(pool.client.queries[8]?.values).toEqual(["tx_str"]);
  });

  it("preserves prototype-method submittables, non-function 3rd args on string queries, and custom thenables on connect()", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());

    // Prototype-method submittable (mirrors pg-cursor / pg.Query) keeps exact identity.
    class FakeCursor {
      public readonly text = "SELECT * FROM invoice";
      public submit(): void {
        // noop
      }
    }
    const protoCursor = new FakeCursor();
    await audit.as({ type: "user", id: "usr_proto_cursor" }, async () => {
      await pool.query(protoCursor);
    });
    expect(pool.client.queries[0]?.raw).toBe(protoCursor);

    // Non-function 3rd argument on pool.query(text, values, third) stays in slot 3 and does not shift into values.
    await audit.as({ type: "user", id: "usr_third_arg" }, async () => {
      await (pool.query as unknown as (a: string, b: unknown[], c: unknown) => Promise<unknown>)(
        "SELECT $1::int",
        [1],
        [999],
      );
    });
    expect(pool.client.queries[1]?.values).toEqual([1]);
    expect(pool.lastQueryThirdArg).toEqual([999]);

    // pool.query(fn) preserves pg-pool's function-first-arg guard (returns undefined synchronously
    // and delivers the Error to `fn` asynchronously instead of rewriting `fn` into a config object).
    let fnErr: unknown;
    const disallowedFn = (err?: unknown) => {
      fnErr = err;
    };
    (disallowedFn as unknown as { text: string }).text = "SELECT 1";
    expect(pool.query(disallowedFn)).toBeUndefined();
    await Promise.resolve();
    expect(fnErr).toBeInstanceOf(Error);
    expect((fnErr as Error).message).toContain("Passing a function");

    // Custom non-chainable (void-returning) PromiseLike thenables returned by pool.connect():
    // patches the client on fulfill and propagates rejections cleanly.
    const fakeClient = new FakeClient();
    const customPool: PgPoolLike = {
      query: () => Promise.resolve({ rows: [] }),
      on: () => customPool,
      connect: () => ({
        // biome-ignore lint/suspicious/noThenProperty: intentionally testing non-chainable custom thenable
        then(onFulfilled: (c: FakeClient) => void) {
          queueMicrotask(() => onFulfilled(fakeClient));
        },
      }),
    };
    const wrappedCustom = wrapPgPool(customPool);
    const connected = await (wrappedCustom.connect as () => Promise<FakeClient>)();
    expect(connected).toBe(fakeClient);
    await audit.as({ type: "user", id: "usr_custom_conn" }, async () => {
      await connected.query({
        text: "UPDATE invoice SET status = $1",
        values: ["patched"],
        name: "custom_stmt",
      });
    });
    expect(fakeClient.queries).toHaveLength(1);
    expect(decodeScope(fakeClient.queries[0]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_custom_conn",
    });
    expect(fakeClient.queries[0]?.name).toBeUndefined();

    // Rejecting non-chainable PromiseLike thenable propagates rejection instead of throwing TypeError.
    const rejectingPool: PgPoolLike = {
      query: () => Promise.resolve({ rows: [] }),
      on: () => rejectingPool,
      connect: () => ({
        // biome-ignore lint/suspicious/noThenProperty: intentionally testing rejecting PromiseLike thenable
        then(_onFulfilled: unknown, onRejected: (err: Error) => void) {
          queueMicrotask(() => onRejected(new Error("thenable connect failed")));
        },
      }),
    };
    const wrappedRejecting = wrapPgPool(rejectingPool);
    await expect((wrappedRejecting.connect as () => Promise<unknown>)()).rejects.toThrow(
      "thenable connect failed",
    );

    // Nested thenable assimilation (thenable resolving to Promise.resolve(client)) still patches client.
    const nestedClient = new FakeClient();
    const nestedThenablePool: PgPoolLike = {
      query: () => Promise.resolve({ rows: [] }),
      on: () => nestedThenablePool,
      connect: () => ({
        // biome-ignore lint/suspicious/noThenProperty: intentionally testing nested thenable assimilation
        then(onFulfilled: (c: Promise<FakeClient>) => void) {
          onFulfilled(Promise.resolve(nestedClient));
        },
      }),
    };
    const wrappedNested = wrapPgPool(nestedThenablePool);
    const connectedNested = await (wrappedNested.connect as () => Promise<FakeClient>)();
    expect(connectedNested).toBe(nestedClient);
    await audit.as({ type: "user", id: "usr_nested_conn" }, async () => {
      await connectedNested.query({ text: "UPDATE invoice SET status = 'nested'", name: "n_stmt" });
    });
    expect(decodeScope(nestedClient.queries[0]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_nested_conn",
    });
    expect(nestedClient.queries[0]?.name).toBeUndefined();

    // Synchronous non-thenable connect(), connect(cb, undefined), connect(opts, cb), and
    // connect(undefined, trailingFn) returning a Promise (pg-pool semantics) all patch clients.
    const syncClient = new FakeClient();
    const cbTrailingClient = new FakeClient();
    const cbOptsClient = new FakeClient();
    const promiseWithTrailingFnClient = new FakeClient();
    const syncPool: PgPoolLike = {
      query: () => Promise.resolve({ rows: [] }),
      on: () => syncPool,
      connect: (...args: unknown[]) => {
        if (typeof args[0] === "function") {
          (args[0] as (e: null, c: FakeClient, d: () => void) => void)(
            null,
            cbTrailingClient,
            () => undefined,
          );
          return undefined;
        }
        if (args[0] === undefined && typeof args[1] === "function") {
          return Promise.resolve(promiseWithTrailingFnClient);
        }
        if (typeof args[1] === "function") {
          (args[1] as (e: null, c: FakeClient, d: () => void) => void)(
            null,
            cbOptsClient,
            () => undefined,
          );
          return undefined;
        }
        return syncClient;
      },
    };
    const wrappedSync = wrapPgPool(syncPool);
    const gotSync = (wrappedSync.connect as () => FakeClient)();
    expect(gotSync).toBe(syncClient);
    let gotTrailing: FakeClient | undefined;
    (
      wrappedSync.connect as (
        cb: (e: unknown, c: FakeClient, d: () => void) => void,
        extra: undefined,
      ) => void
    )((_e, c) => {
      gotTrailing = c;
    }, undefined);
    let gotOpts: FakeClient | undefined;
    (
      wrappedSync.connect as (
        opts: { role: string },
        cb: (e: unknown, c: FakeClient, d: () => void) => void,
      ) => void
    )({ role: "rw" }, (_e, c) => {
      gotOpts = c;
    });
    const gotPromiseTrailing = await (
      wrappedSync.connect as (first: undefined, trailing: () => void) => Promise<FakeClient>
    )(undefined, () => undefined);
    expect(gotPromiseTrailing).toBe(promiseWithTrailingFnClient);
    await audit.as({ type: "user", id: "usr_sync_cb" }, async () => {
      await gotSync.query({ text: "UPDATE invoice SET status = 's1'", name: "s1" });
      await gotTrailing?.query({ text: "UPDATE invoice SET status = 's2'", name: "s2" });
      await gotOpts?.query({ text: "UPDATE invoice SET status = 's3'", name: "s3" });
      await gotPromiseTrailing.query({ text: "UPDATE invoice SET status = 's4'", name: "s4" });
    });
    for (const c of [syncClient, cbTrailingClient, cbOptsClient, promiseWithTrailingFnClient]) {
      expect(c.queries).toHaveLength(1);
      expect(decodeScope(c.queries[0]?.text ?? "").actor).toEqual({
        type: "user",
        id: "usr_sync_cb",
      });
      expect(c.queries[0]?.name).toBeUndefined();
    }
  });

  it("passes stateful/#private, frozen, and callable submittables through untouched with exact identity and cancel()", async () => {
    class PrivateCursor {
      #conn: unknown = null;
      public connection: unknown = null;
      public state = "idle";
      public readonly text = "SELECT * FROM invoice";

      public submit(conn: unknown): void {
        this.#conn = conn;
        this.connection = conn;
        this.state = "running";
      }

      public read(): unknown {
        if (this.#conn === null) {
          throw new Error("cursor was never submitted");
        }
        return this.#conn;
      }
    }

    const pool = wrapPgPool(new FakeQueuingPool());
    const client = await pool.connect();
    try {
      await audit.as({ type: "user", id: "usr_sub" }, async () => {
        const cursor = new PrivateCursor();
        const returned = client.query(cursor);
        expect(returned).toBe(cursor);
        expect(pool.client.activeQuery).toBe(cursor);
        expect(cursor.state).toBe("running");
        expect(cursor.connection).toBe(pool.client.connection);
        expect(cursor.read()).toBe(pool.client.connection);
        expect(client.cancel(client, cursor)).toBe(true);
        expect(pool.client.queries[0]?.text).toBe("SELECT * FROM invoice");

        const frozenSubmit = Object.freeze({
          text: "SELECT 1",
          submit: vi.fn(),
        });
        expect(client.query(frozenSubmit)).toBe(frozenSubmit);
        expect(frozenSubmit.submit).toHaveBeenCalledWith(pool.client.connection);
        expect(pool.client.queries[1]?.text).toBe("SELECT 1");

        function callableSub() {
          // noop
        }
        const callableSubmit = vi.fn();
        (callableSub as unknown as { text: string; submit: typeof callableSubmit }).text =
          "SELECT 2";
        (callableSub as unknown as { submit: typeof callableSubmit }).submit = callableSubmit;
        expect(client.query(callableSub as unknown as { submit: () => void })).toBe(callableSub);
        expect(pool.client.activeQuery).toBe(callableSub);
        expect(callableSubmit).toHaveBeenCalledWith(pool.client.connection);
        expect(pool.client.queries[2]?.text).toBe("SELECT 2");
        expect(client.cancel(client, callableSub)).toBe(true);
        expect(pool.client.cancelledQueries).toEqual([cursor, callableSub]);
      });
    } finally {
      pool.release();
    }

    // Callback connect error forwards cleanly through wrapPoolConnectCallback without throwing.
    pool.failNextConnect = new Error("connect failed");
    let connectErr: unknown;
    pool.connect((err) => {
      connectErr = err;
    });
    expect(connectErr).toBeInstanceOf(Error);
    expect((connectErr as Error).message).toBe("connect failed");
  });

  it("preserves trailing callback in pool.query(text, undefined, callback)", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    let callbackCalled = false;

    await audit.as({ type: "user", id: "usr_undef_cb" }, async () => {
      await new Promise<void>((resolve, reject) => {
        pool.query("SELECT 1", undefined, (err: unknown) => {
          callbackCalled = true;
          if (err) reject(err);
          else resolve();
        });
      });
    });

    expect(callbackCalled).toBe(true);
    expect(pool.client.queries).toHaveLength(1);
    expect(decodeScope(pool.client.queries[0]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_undef_cb",
    });
  });

  it("drops name on queued pre-tagged pool.query configs and keeps queued untagged configs unscoped under pool saturation", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const held = await pool.connect();
    expect(held).toBe(pool.client);

    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "queued_pre_actor" },
    });
    const queuedPreTagged = pool.query({
      text: preTagged,
      values: ["queued"],
      name: "queued_stmt",
    });
    const queuedUntagged = pool.query({
      text: "UPDATE invoice SET status = $1",
      values: ["unscoped_cfg"],
      name: "unscoped_cfg_stmt",
    });

    await audit.as({ type: "user", id: "usr_intruder" }, async () => {
      pool.release();
      await Promise.all([queuedPreTagged, queuedUntagged]);
    });

    expect(pool.client.queries).toHaveLength(2);
    expect(pool.client.queries[0]?.text).toBe(preTagged);
    expect(pool.client.queries[0]?.name).toBeUndefined();
    expect(decodeScope(pool.client.queries[0]?.text ?? "").actor).toEqual({
      type: "service",
      id: "queued_pre_actor",
    });

    // Untagged config object enqueued outside any scope stays untagged and keeps its statement name.
    expect(pool.client.queries[1]?.text).toBe("UPDATE invoice SET status = $1");
    expect(isTagged(pool.client.queries[1]?.text ?? "")).toBe(false);
    expect(pool.client.queries[1]?.name).toBe("unscoped_cfg_stmt");
  });

  it("clones config classes with prototype getters, frozen prototypes, and non-enumerable properties without throwing", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());

    class BaseQuery {
      readonly #sql: string;
      public constructor(sql: string) {
        this.#sql = sql;
      }
      public get text(): string {
        return this.#sql;
      }
      public get name(): string {
        return "base_stmt";
      }
    }

    const makeShadowedQuery = (sql: string): BaseQuery => {
      const instance = new BaseQuery(sql);
      // Mirrors ES2022 subclass field `name = "sub_stmt"` shadowing a prototype `get name()` accessor.
      Object.defineProperty(instance, "name", {
        value: "sub_stmt",
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return instance;
    };

    const frozenProto = Object.freeze({
      text: "SELECT 3",
      name: "frozen_proto_stmt",
      rowMode: "array",
    });
    const fromFrozenProto = Object.create(frozenProto) as PgQueryConfig;

    const nonEnumCfg: PgQueryConfig = { text: "SELECT 4" };
    Object.defineProperty(nonEnumCfg, "rowMode", { value: "array", enumerable: false });
    Object.defineProperty(nonEnumCfg, "name", { value: "non_enum_stmt", enumerable: false });

    // Outside audit.as(): preserves prototype getters, shadowed own fields, frozen prototype, and non-enumerable props.
    await pool.query(new BaseQuery("SELECT 1"));
    await pool.query(makeShadowedQuery("SELECT 2"));
    await pool.query(fromFrozenProto);
    await pool.query(nonEnumCfg);

    expect(pool.client.queries[0]?.text).toBe("SELECT 1");
    expect(pool.client.queries[0]?.name).toBe("base_stmt");
    expect(pool.client.queries[1]?.text).toBe("SELECT 2");
    expect(pool.client.queries[1]?.name).toBe("sub_stmt");
    expect(pool.client.queries[2]?.text).toBe("SELECT 3");
    expect(pool.client.queries[2]?.name).toBe("frozen_proto_stmt");
    expect((pool.client.queries[2]?.raw as { rowMode?: string } | undefined)?.rowMode).toBe(
      "array",
    );
    expect(pool.client.queries[3]?.text).toBe("SELECT 4");
    expect(pool.client.queries[3]?.name).toBe("non_enum_stmt");
    expect((pool.client.queries[3]?.raw as { rowMode?: string } | undefined)?.rowMode).toBe(
      "array",
    );

    // Inside audit.as(): tags text cleanly without TypeError and drops/shadows name while preserving rowMode.
    await audit.as({ type: "user", id: "usr_proto_cls" }, async () => {
      await pool.query(new BaseQuery("SELECT 5"));
      await pool.query(makeShadowedQuery("SELECT 6"));
      await pool.query(fromFrozenProto);
      await pool.query(nonEnumCfg);
    });

    for (const idx of [4, 5, 6, 7]) {
      expect(decodeScope(pool.client.queries[idx]?.text ?? "").actor).toEqual({
        type: "user",
        id: "usr_proto_cls",
      });
      expect(pool.client.queries[idx]?.name).toBeUndefined();
    }
    expect((pool.client.queries[6]?.raw as { rowMode?: string } | undefined)?.rowMode).toBe(
      "array",
    );
    expect((pool.client.queries[7]?.raw as { rowMode?: string } | undefined)?.rowMode).toBe(
      "array",
    );
  });

  it("restores caller AsyncLocalStorage context in queued pool.connect(cb) callbacks under saturation", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const held = await pool.connect();
    expect(held).toBe(pool.client);

    const observedActors: Array<string | null> = [];
    const actorBPending = audit.as({ type: "user", id: "usr_cb_b" }, () => {
      return new Promise<void>((resolve, reject) => {
        pool.connect((err, client, done) => {
          if (err) {
            reject(err);
            return;
          }
          observedActors.push(audit.current()?.actor.id ?? null);
          client.query("UPDATE invoice SET status = 'from_b'").then(() => {
            done();
            resolve();
          }, reject);
        });
      });
    });

    const unscopedPending = new Promise<void>((resolve, reject) => {
      pool.connect((err, client, done) => {
        if (err) {
          reject(err);
          return;
        }
        observedActors.push(audit.current()?.actor.id ?? null);
        client.query("UPDATE invoice SET status = 'unscoped_cb'").then(() => {
          done();
          resolve();
        }, reject);
      });
    });

    await audit.as({ type: "user", id: "usr_intruder" }, async () => {
      pool.release();
      await Promise.all([actorBPending, unscopedPending]);
    });

    expect(observedActors).toEqual(["usr_cb_b", null]);
    expect(pool.client.queries).toHaveLength(2);
    expect(decodeScope(pool.client.queries[0]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_cb_b",
    });
    expect(isTagged(pool.client.queries[1]?.text ?? "")).toBe(false);
    expect(decodeScope(pool.client.queries[1]?.text ?? "").actor).toBeNull();
  });

  it("patches clients before pre-registered connect listeners and falls back to pool.on without prependListener", async () => {
    const preTagged = tagSql("SET application_name = 'app'", {
      actor: { type: "service", id: "init_hook" },
    });

    const rawPool = new FakeQueuingPool();
    rawPool.on("connect", (client: FakeClient) => {
      void client.query({ text: preTagged, name: "init_hook_stmt" });
    });
    const pool = wrapPgPool(rawPool);

    await pool.query("SELECT 1");
    expect(pool.client.queries[0]?.text).toBe(preTagged);
    expect(pool.client.queries[0]?.name).toBeUndefined();

    // Minimal PgPoolLike without prependListener still patches via pool.on("connect").
    const connectListeners: Array<(client: unknown) => void> = [];
    const minimalClient = new FakeClient();
    const minimalPool: PgPoolLike = {
      query: () => Promise.resolve({ rows: [] }),
      on: (_event, listener) => {
        connectListeners.push(listener);
        return minimalPool;
      },
    };
    wrapPgPool(minimalPool);
    for (const listener of connectListeners) {
      listener(minimalClient);
    }
    await minimalClient.query({ text: preTagged, name: "minimal_on_stmt" });
    expect(minimalClient.queries[0]?.name).toBeUndefined();
  });

  it("enforces pool-entry actor decisions via decidedPoolConfigs even when pool.query bypasses pool.connect", async () => {
    const connectListeners: Array<(client: unknown) => void> = [];
    const internalClient = new FakeClient();
    const queued: Array<() => void> = [];

    interface DirectDispatchPool extends PgPoolLike {
      query(first: unknown, second?: unknown): Promise<{ rows: unknown[] }>;
      drain(): void;
    }

    // Minimal PgPoolLike with NO `connect` method: queued pool.query() dispatches straight
    // to internalClient.query() inside whichever AsyncLocalStorage scope drains the queue.
    const directDispatchPool: DirectDispatchPool = {
      on: (_event, listener) => {
        connectListeners.push(listener);
        return directDispatchPool;
      },
      query(first: unknown, second?: unknown) {
        return new Promise((resolve, reject) => {
          queued.push(() => {
            internalClient.query(first, second).then(resolve, reject);
          });
        });
      },
      drain() {
        while (queued.length > 0) {
          queued.shift()?.();
        }
      },
    };

    const pool = wrapPgPool(directDispatchPool);
    for (const listener of connectListeners) {
      listener(internalClient);
    }

    const unscopedString = pool.query("UPDATE invoice SET status = 'unscoped_str'");
    const unscopedConfig = pool.query({
      text: "UPDATE invoice SET status = $1",
      values: ["unscoped_cfg"],
      name: "direct_unscoped_stmt",
    });
    const scopedConfig = audit.as({ type: "user", id: "usr_direct_alpha" }, () =>
      pool.query({
        text: "UPDATE invoice SET status = $1",
        values: ["scoped_cfg"],
        name: "direct_scoped_stmt",
      }),
    );

    await audit.as({ type: "user", id: "usr_intruder" }, async () => {
      pool.drain();
      await Promise.all([unscopedString, unscopedConfig, scopedConfig]);
    });

    expect(internalClient.queries).toHaveLength(3);
    expect(internalClient.queries[0]?.text).toBe("UPDATE invoice SET status = 'unscoped_str'");
    expect(isTagged(internalClient.queries[0]?.text ?? "")).toBe(false);
    expect(internalClient.queries[1]?.text).toBe("UPDATE invoice SET status = $1");
    expect(isTagged(internalClient.queries[1]?.text ?? "")).toBe(false);
    expect(internalClient.queries[1]?.name).toBe("direct_unscoped_stmt");
    expect(decodeScope(internalClient.queries[2]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_direct_alpha",
    });
    expect(internalClient.queries[2]?.name).toBeUndefined();
  });

  it("passes submittables (such as pg-cursor) through untouched", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const cursor = {
      text: "SELECT * FROM invoice",
      submit: vi.fn(),
    };

    await audit.as({ type: "user", id: "usr_cursor" }, async () => {
      await pool.query(cursor);
    });

    expect(pool.client.queries[0]?.raw).toBe(cursor);
    expect(cursor.text).toBe("SELECT * FROM invoice");
  });

  it("prevents actor leakage when queued pool.query callbacks resume inside another scope", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());

    // 1. Acquire the single connection so subsequent pool.query() calls queue in `waiters`.
    const heldClient = await pool.connect();
    expect(heldClient).toBe(pool.client);

    // 2. Enqueue an actor-less query AND a query for usr_alpha while the pool is saturated.
    const actorlessPromise = pool.query("UPDATE invoice SET status = 'unscoped' WHERE id = 1");
    const alphaPromise = audit.as({ type: "user", id: "usr_alpha" }, () =>
      pool.query("UPDATE invoice SET status = 'alpha' WHERE id = 2"),
    );

    // 3. Release the held connection INSIDE a completely different actor's scope (`usr_intruder`)!
    await audit.as({ type: "user", id: "usr_intruder" }, async () => {
      pool.release();
      await Promise.all([actorlessPromise, alphaPromise]);
    });

    expect(pool.client.queries).toHaveLength(2);

    // The actor-less query MUST remain completely untagged (never picking up usr_intruder).
    const firstText = pool.client.queries[0]?.text ?? "";
    expect(isTagged(firstText)).toBe(false);
    expect(decodeScope(firstText).actor).toBeNull();

    // The alpha query MUST retain usr_alpha (never picking up usr_intruder).
    const secondText = pool.client.queries[1]?.text ?? "";
    expect(decodeScope(secondText).actor).toEqual({ type: "user", id: "usr_alpha" });
  });

  it("tags statements issued on checked-out clients from the caller's active scope", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const client = await pool.connect();

    await audit.as({ type: "user", id: "usr_tx" }, async () => {
      await client.query({
        text: "UPDATE invoice SET status = $1",
        values: ["tx"],
        name: "tx_upd",
      });
    });
    pool.release();

    expect(pool.client.queries).toHaveLength(1);
    expect(pool.client.queries[0]?.name).toBeUndefined();
    expect(decodeScope(pool.client.queries[0]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_tx",
    });
  });
});
