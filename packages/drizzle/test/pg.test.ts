import { EventEmitter } from "node:events";
import { audit, decodeScope, isTagged, tagSql } from "@auditstream/node";
import { describe, expect, it, vi } from "vitest";
import { type PgClientLike, type PgPoolLike, type PgQueryConfig, wrapPgPool } from "../src/pg.js";

interface RecordedQuery {
  readonly text: string | undefined;
  readonly values: unknown;
  readonly name: string | undefined;
  readonly raw: unknown;
}

class FakeClient implements PgClientLike {
  public readonly queries: RecordedQuery[] = [];

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
    const cb =
      typeof second === "function" ? second : typeof third === "function" ? third : undefined;
    if (typeof first === "string") {
      this.queries.push({
        text: first,
        values: typeof second === "function" ? undefined : second,
        name: undefined,
        raw: first,
      });
    } else if (typeof first === "object" && first !== null) {
      const cfg = first as PgQueryConfig;
      this.queries.push({
        text: cfg.text,
        values: cfg.values ?? (typeof second === "function" ? undefined : second),
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

  public connect(): Promise<FakeClient>;
  public connect(cb: (err: Error | null, client: FakeClient, done: () => void) => void): void;
  public connect(
    cb?: (err: Error | null, client: FakeClient, done: () => void) => void,
  ): Promise<FakeClient> | undefined {
    const dispatch = (
      fn: (err: Error | null, client: FakeClient, done: () => void) => void,
    ): void => {
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

  it("adds at most one tag, drops name whenever a tag is added, and keeps caller config unmutated", async () => {
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

  it("preserves prototype-inherited fields, handles frozen/null-prototype configs, reads text once, and shadows inherited name", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "proto_pre" },
    });

    // 1. Prototype-inherited text, name, and rowMode.
    const inheritedPreTagged = Object.create({
      text: preTagged,
      name: "proto_stmt",
      rowMode: "array",
    }) as PgQueryConfig;
    await pool.query(inheritedPreTagged);
    expect(pool.client.queries[0]?.text).toBe(preTagged);
    expect(pool.client.queries[0]?.name).toBeUndefined();
    expect((pool.client.queries[0]?.raw as PgQueryConfig | undefined)?.rowMode).toBe("array");

    // 2. Frozen config (must not throw and must not mutate caller).
    const frozen = Object.freeze({
      text: preTagged,
      values: ["frozen"],
      name: "frozen_stmt",
    });
    await pool.query(frozen);
    expect(frozen.name).toBe("frozen_stmt");
    expect(pool.client.queries[1]?.text).toBe(preTagged);
    expect(pool.client.queries[1]?.name).toBeUndefined();

    // 3. Null-prototype config.
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, {
      text: "UPDATE invoice SET status = 'np'",
      name: "np_stmt",
    }) as PgQueryConfig;
    await audit.as({ type: "user", id: "usr_np" }, async () => {
      await pool.query(nullProto);
    });
    expect(Object.getPrototypeOf(pool.client.queries[2]?.raw)).toBeNull();
    expect(pool.client.queries[2]?.name).toBeUndefined();
    expect(decodeScope(pool.client.queries[2]?.text ?? "").actor).toEqual({
      type: "user",
      id: "usr_np",
    });

    // 4. Getter TOCTOU guard: text getter is read once and frozen on the forwarded config.
    let reads = 0;
    const getterConfig = {
      get text(): string {
        reads += 1;
        return reads === 1 ? preTagged : "UPDATE invoice SET status = 'swapped'";
      },
      name: "toctou_stmt",
    } as PgQueryConfig;
    await pool.query(getterConfig);
    expect(reads).toBe(1);
    expect(pool.client.queries[3]?.text).toBe(preTagged);
    expect(pool.client.queries[3]?.name).toBeUndefined();

    // 5. Prototype-polluted `Object.prototype.name` is shadowed on tagged configs.
    Object.defineProperty(Object.prototype, "name", {
      value: "polluted_stmt",
      writable: true,
      configurable: true,
    });
    try {
      await pool.query({ text: preTagged });
      expect(pool.client.queries[4]?.name).toBeUndefined();
    } finally {
      delete (Object.prototype as { name?: unknown }).name;
    }
  });

  it("drops name on queued pre-tagged pool.query configs under pool saturation without leaking intruder actor", async () => {
    const pool = wrapPgPool(new FakeQueuingPool());
    const held = await pool.connect();
    expect(held).toBe(pool.client);

    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "queued_pre_actor" },
    });
    const queuedPromise = pool.query({
      text: preTagged,
      values: ["queued"],
      name: "queued_stmt",
    });

    await audit.as({ type: "user", id: "usr_intruder" }, async () => {
      pool.release();
      await queuedPromise;
    });

    expect(pool.client.queries).toHaveLength(1);
    expect(pool.client.queries[0]?.text).toBe(preTagged);
    expect(pool.client.queries[0]?.name).toBeUndefined();
    expect(decodeScope(pool.client.queries[0]?.text ?? "").actor).toEqual({
      type: "service",
      id: "queued_pre_actor",
    });
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
