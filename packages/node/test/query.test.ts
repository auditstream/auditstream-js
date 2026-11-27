import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type AuditQuery,
  type AuditQueryExecutor,
  type AuditQueryPage,
  type AuditQueryValues,
  AuditstreamError,
  audit,
  MAX_QUERY_OPS,
} from "../src/index.js";

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "100",
    event_id: "019ab123-4567-7000-8000-000000000100",
    occurred_at: "2026-11-24T10:15:30.123456Z",
    xact_id: "5001",
    source: "db",
    schema_name: "public",
    table_name: "invoice",
    table_oid: 16384,
    op: "UPDATE",
    record_id: { id: 7 },
    before: { id: 7, status: "open" },
    after: { id: 7, status: "paid" },
    changed: ["status"],
    actor: { type: "user", id: "usr_1", tenant: "org_acme" },
    context: { requestId: "req_1" },
    actor_source: "comment",
    db_user: "app_user",
    schema_version: 1,
    ...overrides,
  };
}

describe("audit.query() types and constants", () => {
  it("exports mutable primitive-only AuditQueryValues and MAX_QUERY_OPS = 20", () => {
    expectTypeOf<AuditQueryValues>().toEqualTypeOf<(string | number)[]>();
    expectTypeOf<AuditQueryPage["nextCursor"]>().toEqualTypeOf<string | null>();
    expectTypeOf<AuditQueryPage["hasMore"]>().toEqualTypeOf<boolean>();
    expect(MAX_QUERY_OPS).toBe(20);
  });
});

describe("audit.query()", () => {
  it("builds parameterized SQL with microsecond to_char, starts_with, tenant/actor OR, and limit + 1", async () => {
    const calls: Array<{ text: string; values: AuditQueryValues }> = [];
    const exec: AuditQueryExecutor = (text, values) => {
      calls.push({ text, values: [...values] });
      return { rows: [makeRow({ id: "200" }), makeRow({ id: "199" }), makeRow({ id: "198" })] };
    };

    const query: AuditQuery = {
      schema: "custom_audit",
      schemaName: "public",
      table: "invoice",
      recordId: { id: 7 },
      actor: "usr_1",
      tenant: "org_acme",
      source: "db",
      op: ["INSERT", "UPDATE"],
      opPrefix: "inv%_x",
      since: "2026-11-01T00:00:00.000000Z",
      until: new Date("2026-12-01T00:00:00.000Z"),
      limit: 2,
    };

    const page = await audit.query(exec, query);

    expect(calls).toHaveLength(1);
    const sql = calls[0]?.text ?? "";
    expect(sql).toContain(
      `pg_catalog.to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`,
    );
    expect(sql).toContain('FROM "custom_audit"."changes"');
    expect(sql).toContain("schema_name = $1::text");
    expect(sql).toContain("table_name = $2::text");
    expect(sql).toContain("record_id = $3::jsonb");
    expect(sql).toContain("(actor->>'id' = $4::text OR actor->'onBehalfOf'->>'id' = $4::text)");
    expect(sql).toContain(
      "(actor->>'tenant' = $5::text OR actor->'onBehalfOf'->>'tenant' = $5::text)",
    );
    expect(sql).toContain("source = $6::text");
    expect(sql).toContain("op IN ($7::text, $8::text)");
    expect(sql).toContain("pg_catalog.starts_with(op, $9::text)");
    expect(sql).not.toContain("LIKE");
    expect(sql).toContain("occurred_at >= $10::timestamptz");
    expect(sql).toContain("occurred_at < $11::timestamptz");
    expect(sql).toContain("ORDER BY changes.occurred_at DESC, changes.id DESC LIMIT $12::int");

    expect(calls[0]?.values).toEqual([
      "public",
      "invoice",
      '{"id":7}',
      "usr_1",
      "org_acme",
      "db",
      "INSERT",
      "UPDATE",
      "inv%_x",
      "2026-11-01T00:00:00.000000Z",
      "2026-12-01T00:00:00.000Z",
      3,
    ]);

    expect(page.hasMore).toBe(true);
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((e) => e.id)).toEqual(["200", "199"]);
    expect(typeof page.nextCursor).toBe("string");
  });

  it("paginates with partition-pruning occurred_at <= AND (occurred_at, id) < cursor and reads app events", async () => {
    const calls: Array<{ text: string; values: AuditQueryValues }> = [];
    const page1 = await audit.query(
      (text, values) => {
        calls.push({ text, values: [...values] });
        return [
          makeRow({
            id: "55",
            occurred_at: "2026-11-24T10:15:30.123456Z",
            source: "app",
            schema_name: null,
            table_name: null,
            table_oid: null,
            op: "invoice.exported",
            record_id: { invoice_id: 9 },
            before: null,
            after: { format: "csv" },
            changed: null,
          }),
          makeRow({
            id: "54",
            occurred_at: "2026-11-24T10:15:30.123456Z",
            source: "app",
            schema_name: null,
            table_name: null,
            table_oid: null,
            op: "invoice.sent",
            record_id: { invoice_id: 9 },
            before: null,
            after: { channel: "email" },
            changed: null,
          }),
        ];
      },
      { source: "app", unbounded: true, limit: 1 },
    );

    expect(page1.hasMore).toBe(true);
    expect(page1.entries).toHaveLength(1);
    expect(page1.entries[0]?.source).toBe("app");
    expect(page1.entries[0]?.table_name).toBeNull();
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await audit.query(
      (text, values) => {
        calls.push({ text, values: [...values] });
        return [
          makeRow({
            id: "54",
            occurred_at: "2026-11-24T10:15:30.123456Z",
            source: "app",
            schema_name: null,
            table_name: null,
            table_oid: null,
            op: "invoice.sent",
            record_id: { invoice_id: 9 },
            before: null,
            after: { channel: "email" },
            changed: null,
          }),
        ];
      },
      { source: "app", unbounded: true, limit: 1, cursor: page1.nextCursor ?? undefined },
    );

    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
    expect(page2.entries).toHaveLength(1);
    expect(page2.entries[0]?.id).toBe("54");

    const sql2 = calls[1]?.text ?? "";
    expect(sql2).toContain("occurred_at <= $2::timestamptz");
    expect(sql2).toContain("(occurred_at, id) < ($2::timestamptz, $3::bigint)");
    expect(calls[1]?.values).toEqual(["app", "2026-11-24T10:15:30.123456Z", "55", 2]);
  });

  const leapDay = "2000-02-29T23:59:59.999999Z";

  function cursorFor(t: string, i: string): string {
    return Buffer.from(JSON.stringify({ v: 1, t, i })).toString("base64url");
  }

  it.each([
    [leapDay, "-9223372036854775809"],
    [leapDay, "9223372036854775808"],
    [leapDay, "9".repeat(100)],
    ["1900-02-29T00:00:00.0Z", "1"],
    ["2026-04-31T00:00:00.0Z", "1"],
    ["2026-13-01T00:00:00.0Z", "1"],
    ["0000-01-01T00:00:00.0Z", "1"],
    ["2026-01-01T24:00:00.0Z", "1"],
    ["2026-01-01T00:60:00.0Z", "1"],
    ["2026-01-01T23:59:60.0Z", "1"],
    ["2026-01-01T00:00:61.0Z", "1"],
  ])("rejects an invalid cursor (%s, %s) before calling the executor", async (t, i) => {
    const exec = vi.fn(() => []);
    await expect(
      audit.query(exec, { cursor: cursorFor(t, i), unbounded: true }),
    ).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    [leapDay, "9223372036854775807"],
    ["0001-01-01T00:00:00.1Z", "-9223372036854775808"],
  ])("keeps valid cursor values exact (%s, %s)", async (t, i) => {
    const exec = vi.fn(() => []);
    await audit.query(exec, { cursor: cursorFor(t, i), unbounded: true });
    expect(exec).toHaveBeenCalledWith(expect.any(String), [t, i, 51]);
  });

  const unsupportedText: readonly AuditQuery[] = [
    { schemaName: "public\0" },
    { table: "invoice\0" },
    { actor: "usr\ud800" },
    { tenant: "org\0" },
    { op: ["INSERT", "app.\0"] },
    { opPrefix: "app.\udfff" },
    { recordId: { id: "a\0b" } },
    { recordId: { "\ud800": 1 } },
  ];

  it.each(unsupportedText)(
    "rejects text PostgreSQL cannot compare before SQL %#",
    async (filter) => {
      const exec = vi.fn(() => []);
      await expect(audit.query(exec, { ...filter, unbounded: true })).rejects.toMatchObject({
        name: "AuditstreamError",
        code: "INVALID_QUERY",
      });
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it("passes supplementary characters and literal escape text through to SQL", async () => {
    const exec = vi.fn(() => []);
    await audit.query(exec, { actor: "usr_📦", recordId: { id: "a\\u0000" } });
    expect(exec).toHaveBeenCalledWith(expect.any(String), ['{"id":"a\\\\u0000"}', "usr_📦", 51]);
  });

  it("rejects unbounded queries without explicit unbounded: true and rejects invalid filters before SQL", async () => {
    let called = false;
    const exec: AuditQueryExecutor = () => {
      called = true;
      return [];
    };

    const invalidQueries: readonly AuditQuery[] = [
      {},
      { tenant: "org_acme" },
      { actor: "usr_1", unbounded: false },
      { table: "", unbounded: true },
      { table: "   ", unbounded: true },
      { schemaName: "", unbounded: true },
      { actor: "", unbounded: true },
      { actor: "  ", unbounded: true },
      { tenant: "", unbounded: true },
      { tenant: "\t", unbounded: true },
      { op: "", unbounded: true },
      { op: [], unbounded: true },
      { op: ["INSERT", ""], unbounded: true },
      { op: Array.from({ length: 21 }, (_, i) => `op.${i}`), unbounded: true },
      { opPrefix: "", unbounded: true },
      { opPrefix: "  ", unbounded: true },
      { source: "cli" as "db", unbounded: true },
      { schema: "BadSchema", unbounded: true },
      { limit: 0, unbounded: true },
      { limit: 1001, unbounded: true },
      { since: "" },
      { since: "not-a-date" },
      { since: "2026-02-30" },
      { since: "2026-01-01T24:00:00Z" },
      { since: "2026-01-01T24:00:00.000001Z" },
      { since: "2026-01-01T24:00:00.500000Z" },
      { since: "2026-01-01T23:59:60Z" },
      { since: "2026-01-01T00:00:00+16:00" },
      { until: "2026-01-01T00:00:00-16:00" },
      { since: "2026-01-01T00:00:00+05:60" },
      { since: new Date("-005000-01-01T00:00:00Z") },
      { since: new Date("0000-01-01T00:00:00Z") },
      { until: new Date(8640000000000000) },
      { until: new Date(Number.NaN) },
      { since: "2026-06-15T00:00:00Z", until: "2026-06-15T00:00:00Z" },
      { since: "2026-06-16T00:00:00Z", until: "2026-06-15T00:00:00Z" },
      { since: "2026-06-15T00:00:00.000005Z", until: "2026-06-15T00:00:00.000004Z" },
      { recordId: [] as unknown as { id: number } },
      {
        recordId: {
          toJSON() {
            return undefined;
          },
        } as unknown as { id: number },
      },
      { unbounded: "yes" as unknown as boolean },
      { cursor: "", unbounded: true },
      { cursor: "not-valid-base64!!!", unbounded: true },
      { cursor: "e30", unbounded: true },
      { cursor: `${cursorFor(leapDay, "1")}=`, unbounded: true },
      { cursor: "A".repeat(257), unbounded: true },
      {
        cursor: Buffer.from(JSON.stringify({ v: 1, t: 123, i: "1" })).toString("base64url"),
        unbounded: true,
      },
      {
        cursor: Buffer.from(JSON.stringify({ v: 1, t: leapDay, i: 1 })).toString("base64url"),
        unbounded: true,
      },
    ];

    for (const bad of invalidQueries) {
      await expect(audit.query(exec, bad)).rejects.toThrow(AuditstreamError);
      await expect(audit.query(exec, bad)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    }

    await expect(
      audit.query("not-a-fn" as unknown as AuditQueryExecutor, { unbounded: true }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(audit.query(exec, null as unknown as AuditQuery)).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });

    expect(called).toBe(false);
  });

  it("supports single-string op, YYYY-MM-DD UTC date bounds, and sub-millisecond since < until", async () => {
    const calls: Array<{ text: string; values: AuditQueryValues }> = [];
    const exec: AuditQueryExecutor = (text, values) => {
      calls.push({ text, values: [...values] });
      return [];
    };

    const page = await audit.query(exec, {
      op: "UPDATE",
      since: "2026-06-15",
      until: "2026-06-16T00:00:00.000001Z",
    });

    expect(page).toEqual({ entries: [], nextCursor: null, hasMore: false });
    expect(calls[0]?.text).toContain("op = $1::text");
    expect(calls[0]?.values).toEqual([
      "UPDATE",
      "2026-06-15T00:00:00Z",
      "2026-06-16T00:00:00.000001Z",
      51,
    ]);
  });

  it("accepts PostgreSQL-valid timezone offsets up to +/-15:59 and Date years 0001..9999", async () => {
    const exec = vi.fn<AuditQueryExecutor>(() => []);
    await audit.query(exec, {
      since: "2026-06-15T00:00:00+15:59",
      until: "2026-06-15T00:00:00-15:59",
    });
    await audit.query(exec, {
      since: new Date("0001-01-01T00:00:00.000Z"),
      until: new Date("9999-12-31T23:59:59.999Z"),
    });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
