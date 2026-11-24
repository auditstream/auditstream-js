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

    // Already tagged (e.g. Drizzle 1.x .comment()): never double-tagged.
    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "user", id: "usr_drizzle_comment" },
    });
    await audit.as({ type: "user", id: "usr_outer" }, async () => {
      await pool.query({ text: preTagged, values: ["open"] });
    });
    expect(pool.client.queries[1]?.text).toBe(preTagged);

    // Untagged (outside any scope): preserves `name`.
    await pool.query(originalConfig);
    expect(pool.client.queries[2]?.name).toBe("upd1");
    expect(isTagged(pool.client.queries[2]?.text ?? "")).toBe(false);
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
