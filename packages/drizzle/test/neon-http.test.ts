import { audit, decodeScope, isTagged, tagSql } from "@auditstream/node";
import { describe, expect, it } from "vitest";
import { type NeonHttpClientLike, wrapNeonHttp } from "../src/neon-http.js";

interface LazyQuery {
  readonly text: string;
  readonly params: unknown[] | undefined;
  readonly opts: unknown;
}

interface FakeNeonHttpClient extends NeonHttpClientLike {
  (text: string, params?: unknown[], opts?: unknown): LazyQuery;
  (strings: TemplateStringsArray, ...values: unknown[]): string;
  query(text: string, params?: unknown[], opts?: unknown): LazyQuery;
  transaction(queries: readonly LazyQuery[], opts?: unknown): Promise<readonly LazyQuery[]>;
  readonly queryCalls: LazyQuery[];
  readonly templateCalls: string[];
  readonly txCalls: Array<{ readonly queries: readonly LazyQuery[]; readonly opts: unknown }>;
}

function createFakeNeonHttp(): FakeNeonHttpClient {
  const queryCalls: LazyQuery[] = [];
  const templateCalls: string[] = [];
  const txCalls: Array<{ readonly queries: readonly LazyQuery[]; readonly opts: unknown }> = [];

  const query = (text: string, params?: unknown[], opts?: unknown): LazyQuery => {
    const entry: LazyQuery = { text, params, opts };
    queryCalls.push(entry);
    return entry;
  };

  const fn = ((first: unknown, ...rest: unknown[]) => {
    if (typeof first === "string") {
      return query(first, rest[0] as unknown[] | undefined, rest[1]);
    }
    const strings = first as TemplateStringsArray;
    templateCalls.push(`${strings.join("?")}:${rest.join(",")}`);
    return "template-result";
  }) as FakeNeonHttpClient;

  Object.assign(fn, {
    query,
    queryCalls,
    templateCalls,
    txCalls,
    transaction(queries: readonly LazyQuery[], opts?: unknown) {
      txCalls.push({ queries, opts });
      return Promise.resolve(queries);
    },
  });

  return fn;
}

describe("wrapNeonHttp()", () => {
  it("is idempotent when called twice", () => {
    const raw = createFakeNeonHttp();
    const wrappedOnce = wrapNeonHttp(raw);
    const wrappedTwice = wrapNeonHttp(wrappedOnce);
    expect(wrappedTwice).toBe(wrappedOnce);
  });

  it("tags query() and plain string calls inside a scope, and preserves params and opts", async () => {
    const raw = createFakeNeonHttp();
    const sql = wrapNeonHttp(raw);
    const opts = { arrayMode: true };

    await audit.as({ type: "user", id: "nh_1" }, () => {
      sql.query("UPDATE invoice SET status = $1 WHERE id = $2", ["paid", 1], opts);
      sql("DELETE FROM invoice WHERE id = $1", [2], opts);
    });

    expect(raw.queryCalls).toHaveLength(2);
    for (const call of raw.queryCalls) {
      expect(isTagged(call.text)).toBe(true);
      expect(decodeScope(call.text).actor).toEqual({ type: "user", id: "nh_1" });
      expect(call.opts).toBe(opts);
    }
    expect(raw.queryCalls[0]?.params).toEqual(["paid", 1]);
    expect(raw.queryCalls[1]?.params).toEqual([2]);
  });

  it("captures each query's actor at construction time for transaction([...])", async () => {
    const raw = createFakeNeonHttp();
    const sql = wrapNeonHttp(raw);

    const q1 = await audit.as({ type: "user", id: "actor_a" }, () =>
      sql.query("UPDATE invoice SET status = $1 WHERE id = $2", ["a", 1]),
    );
    const q2 = await audit.as({ type: "service", id: "actor_b" }, () =>
      sql.query("UPDATE invoice SET status = $1 WHERE id = $2", ["b", 2]),
    );
    const q3 = sql.query("UPDATE invoice SET status = $1 WHERE id = $2", ["c", 3]);

    // Execute outside any scope: each lazy query must keep the actor read when built.
    const executed = await sql.transaction([q1, q2, q3], { isolationLevel: "ReadCommitted" });
    expect(executed).toHaveLength(3);
    expect(decodeScope(executed[0]?.text ?? "").actor).toEqual({ type: "user", id: "actor_a" });
    expect(decodeScope(executed[1]?.text ?? "").actor).toEqual({ type: "service", id: "actor_b" });
    expect(isTagged(executed[2]?.text ?? "")).toBe(false);
    expect(raw.txCalls[0]?.opts).toEqual({ isolationLevel: "ReadCommitted" });
  });

  it("does not double-tag already-tagged SQL and leaves tagged-template calls untouched", async () => {
    const raw = createFakeNeonHttp();
    const sql = wrapNeonHttp(raw);

    const preTagged = tagSql("UPDATE invoice SET status = $1", {
      actor: { type: "service", id: "pre" },
    });

    await audit.as({ type: "user", id: "outer" }, () => {
      sql.query(preTagged, ["done"]);
      const tpl = sql`SELECT ${99}`;
      expect(tpl).toBe("template-result");
    });

    expect(raw.queryCalls).toHaveLength(1);
    expect(raw.queryCalls[0]?.text).toBe(preTagged);
    expect(raw.templateCalls).toEqual(["SELECT ?:99"]);
  });
});
