import { audit, decodeScope, isTagged, tagSql } from "@auditstream/node";
import { describe, expect, it } from "vitest";
import {
  type PostgresJsLike,
  type PostgresJsTransactionLike,
  type PostgresJsUnsafeOptions,
  wrapPostgresJs,
} from "../src/postgres-js.js";

interface RecordedUnsafe {
  readonly scope: "root" | "tx" | "savepoint";
  readonly query: string;
  readonly parameters: readonly unknown[] | undefined;
  readonly queryOptions: PostgresJsUnsafeOptions | undefined;
}

interface FakePostgresJsTx extends PostgresJsTransactionLike {
  unsafe(
    query: string,
    parameters?: readonly unknown[],
    queryOptions?: PostgresJsUnsafeOptions,
  ): Promise<unknown[]>;
}

interface FakePostgresJs extends PostgresJsLike {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<string>;
  unsafe(
    query: string,
    parameters?: readonly unknown[],
    queryOptions?: PostgresJsUnsafeOptions,
  ): Promise<unknown[]>;
  readonly calls: RecordedUnsafe[];
  readonly templateCalls: string[];
  readonly beginOptions: Array<string | undefined>;
  readonly savepointNames: Array<string | undefined>;
}

function createFakePostgresJs(): FakePostgresJs {
  const calls: RecordedUnsafe[] = [];
  const templateCalls: string[] = [];
  const beginOptions: Array<string | undefined> = [];
  const savepointNames: Array<string | undefined> = [];

  const makeTx = (scope: "tx" | "savepoint"): PostgresJsTransactionLike => {
    const tx: PostgresJsTransactionLike = {
      unsafe(query, parameters, queryOptions) {
        calls.push({ scope, query, parameters, queryOptions });
        return Promise.resolve([]);
      },
      savepoint(...args: unknown[]) {
        const hasName = typeof args[0] === "string";
        const name = hasName ? (args[0] as string) : undefined;
        const cb = (hasName ? args[1] : args[0]) as (sp: PostgresJsTransactionLike) => unknown;
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

  Object.assign(fn, {
    calls,
    templateCalls,
    beginOptions,
    savepointNames,
    unsafe(query: string, parameters?: readonly unknown[], queryOptions?: PostgresJsUnsafeOptions) {
      calls.push({ scope: "root", query, parameters, queryOptions });
      return Promise.resolve([]);
    },
    begin(...args: unknown[]) {
      const hasOpts = typeof args[0] === "string";
      const opts = hasOpts ? (args[0] as string) : undefined;
      const cb = (hasOpts ? args[1] : args[0]) as (tx: PostgresJsTransactionLike) => unknown;
      beginOptions.push(opts);
      return Promise.resolve(cb(makeTx("tx")));
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

  it("leaves untagged calls and already-tagged SQL unchanged with caller options intact", async () => {
    const raw = createFakePostgresJs();
    const sql = wrapPostgresJs(raw);
    const opts: PostgresJsUnsafeOptions = { prepare: true };

    // Outside any scope: options kept intact (prepare: true).
    await sql.unsafe("SELECT 1", [], opts);

    // Already tagged SQL (for example from Drizzle 1.x .comment()): not double-tagged, options kept intact.
    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "pre_tagged" },
    });
    await audit.as({ type: "user", id: "outer_user" }, async () => {
      await sql.unsafe(preTagged, ["done"], opts);
    });

    expect(raw.calls).toHaveLength(2);
    expect(raw.calls[0]?.query).toBe("SELECT 1");
    expect(raw.calls[0]?.queryOptions).toBe(opts);
    expect(raw.calls[1]?.query).toBe(preTagged);
    expect(raw.calls[1]?.queryOptions).toBe(opts);
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
