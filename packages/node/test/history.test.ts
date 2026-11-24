import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type ActorSource,
  type AuditHistoryValues,
  type AuditOp,
  AuditstreamError,
  audit,
  DEFAULT_HISTORY_LIMIT,
  type ExportRecord,
  type HistoryEntry,
  MAX_HISTORY_LIMIT,
  parseExportRecord,
  SUPPORTED_SCHEMA_VERSION,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const eventSchema = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/event.schema.json"), "utf8"),
) as Record<string, unknown>;

const VALID_EXAMPLES: readonly string[] = [
  JSON.stringify({
    event_id: "019ab123-4567-7000-8000-000000000001",
    occurred_at: "2026-11-24T10:15:30.123456Z",
    source: "db",
    schema_name: "public",
    table_name: "invoice",
    op: "INSERT",
    record_id: { id: 101 },
    before: null,
    after: { id: 101, status: "draft", total: 100.5 },
    changed: null,
    actor: {
      type: "ai_agent",
      id: "billing-agent",
      onBehalfOf: { type: "user", id: "usr_42" },
      tenant: "org_acme",
    },
    context: { requestId: "req_01", source: "api" },
    actor_source: "comment",
    db_user: "app_user",
    schema_version: 1,
  }),
  // Raw JSON line with exact 30-digit PostgreSQL numeric literals (matching spec/schemas/examples/event/valid/db-insert.json & db-update.json)
  `{"event_id":"019ab123-4567-7000-8000-000000000002","occurred_at":"2026-11-24T10:15:31.234567Z","source":"db","schema_name":"public","table_name":"invoice","op":"UPDATE","record_id":{"id":101},"before":{"id":101,"status":"draft","total":123456789012345678901234.567891},"after":{"id":101,"status":"paid","total":123456789012345678901235.000000},"changed":["status","total"],"actor":{"type":"user","id":"usr_42"},"context":null,"actor_source":"set_config","db_user":"app_user","schema_version":1}`,
  JSON.stringify({
    event_id: "019ab123-4567-7000-8000-000000000003",
    occurred_at: "2026-11-24T10:15:32.345678Z",
    source: "db",
    schema_name: "public",
    table_name: "invoice",
    op: "TRUNCATE",
    record_id: null,
    before: null,
    after: null,
    changed: null,
    actor: null,
    context: null,
    actor_source: null,
    db_user: "app_user",
    schema_version: 1,
  }),
  JSON.stringify({
    event_id: "019ab123-4567-7000-8000-000000000004",
    occurred_at: "2026-11-24T10:15:33.456789Z",
    source: "app",
    schema_name: null,
    table_name: null,
    op: "invoice.exported",
    record_id: { id: 101 },
    before: null,
    after: { format: "pdf", destination: "s3://audit-exports/101.pdf" },
    changed: null,
    actor: { type: "service", id: "export-worker", tenant: "org_acme" },
    context: { requestId: "req_02", source: "worker" },
    actor_source: "comment",
    db_user: "app_user",
    schema_version: 1,
  }),
];

describe("HistoryEntry and ExportRecord types", () => {
  it("pins normative Specification 0.1.0 field types with expectTypeOf", () => {
    expectTypeOf<HistoryEntry["id"]>().toEqualTypeOf<string>();
    expectTypeOf<HistoryEntry["xact_id"]>().toEqualTypeOf<string>();
    expectTypeOf<HistoryEntry["table_oid"]>().toEqualTypeOf<number | null>();
    expectTypeOf<HistoryEntry["op"]>().toEqualTypeOf<AuditOp>();
    expectTypeOf<HistoryEntry["actor_source"]>().toEqualTypeOf<ActorSource | null>();
    expectTypeOf<HistoryEntry["schema_version"]>().toEqualTypeOf<number>();

    expectTypeOf<ExportRecord["event_id"]>().toEqualTypeOf<string>();
    expectTypeOf<ExportRecord["occurred_at"]>().toEqualTypeOf<string>();
    expectTypeOf<ExportRecord["source"]>().toEqualTypeOf<"db" | "app">();
    expectTypeOf<ExportRecord["op"]>().toEqualTypeOf<AuditOp>();
    expectTypeOf<ExportRecord["actor_source"]>().toEqualTypeOf<ActorSource | null>();
    expectTypeOf<ExportRecord["schema_version"]>().toEqualTypeOf<number>();

    // ExportRecord must NOT include internal columns id, xact_id, or table_oid.
    expectTypeOf<keyof ExportRecord>().toEqualTypeOf<
      | "event_id"
      | "occurred_at"
      | "source"
      | "schema_name"
      | "table_name"
      | "op"
      | "record_id"
      | "before"
      | "after"
      | "changed"
      | "actor"
      | "context"
      | "actor_source"
      | "db_user"
      | "schema_version"
    >();

    expect(SUPPORTED_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_HISTORY_LIMIT).toBe(50);
    expect(MAX_HISTORY_LIMIT).toBe(1000);
  });
});

describe("parseExportRecord()", () => {
  it("validates every Spec 0.1.0 example against event.schema.json (ajv) and parses cleanly", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats.default(ajv);
    const validate = ajv.compile(eventSchema);

    for (const line of VALID_EXAMPLES) {
      const jsonObj = JSON.parse(line) as unknown;
      expect(validate(jsonObj), JSON.stringify(validate.errors)).toBe(true);

      const parsed = parseExportRecord(line);
      expect(parsed.schema_version).toBe(1);
    }
  });

  it("preserves a 30-digit numeric in after unchanged on Node while keeping safe numbers numeric", () => {
    const line =
      `{"event_id":"019ab123-4567-7000-8000-000000000010",` +
      `"occurred_at":"2026-11-24T10:15:30.123456Z","source":"db","schema_name":"public",` +
      `"table_name":"invoice","op":"INSERT","record_id":{"id":101},"before":null,` +
      `"after":{"id":101,"total":123456789012345678901234.567891,"big_int":123456789012345678901234567890},` +
      `"changed":null,"actor":null,"context":null,"actor_source":null,"db_user":"app_user","schema_version":1,"future_field":"ignored"}`;

    const record = parseExportRecord(line);
    expect(record.after?.id).toBe(101);
    expect(record.after?.total).toBe("123456789012345678901234.567891");
    expect(record.after?.big_int).toBe("123456789012345678901234567890");
    expect(record.schema_version).toBe(1);
  });

  it("throws AuditstreamError(INVALID_RECORD) on invalid JSON, missing required fields, or unsupported schema_version", () => {
    const cases: readonly string[] = [
      "",
      "not json",
      "[]",
      JSON.stringify({ schema_version: 1 }),
      // Wrong schema_version
      JSON.stringify({
        event_id: "019ab123-4567-7000-8000-000000000001",
        occurred_at: "2026-11-24T10:15:30.123456Z",
        source: "db",
        op: "INSERT",
        db_user: "app_user",
        schema_version: 2,
      }),
      // Invalid actor_source
      JSON.stringify({
        event_id: "019ab123-4567-7000-8000-000000000001",
        occurred_at: "2026-11-24T10:15:30.123456Z",
        source: "db",
        op: "INSERT",
        actor_source: "unknown",
        db_user: "app_user",
        schema_version: 1,
      }),
      // Invalid source
      JSON.stringify({
        event_id: "019ab123-4567-7000-8000-000000000001",
        occurred_at: "2026-11-24T10:15:30.123456Z",
        source: "cli",
        op: "INSERT",
        db_user: "app_user",
        schema_version: 1,
      }),
    ];

    for (const input of cases) {
      expect(() => parseExportRecord(input)).toThrow(AuditstreamError);
      try {
        parseExportRecord(input);
      } catch (err) {
        expect(err).toBeInstanceOf(AuditstreamError);
        expect((err as AuditstreamError).code).toBe("INVALID_RECORD");
      }
    }
  });
});

describe("audit.history()", () => {
  it("sends one parameterized SELECT with quoted schema, default limit 50, newest first", async () => {
    const calls: Array<{ text: string; values: AuditHistoryValues }> = [];
    const entries = await audit.history(
      (text, values) => {
        calls.push({ text, values });
        return {
          rows: [
            {
              id: "42",
              event_id: "019ab123-4567-7000-8000-000000000001",
              occurred_at: new Date("2026-11-24T10:15:30.123Z"),
              xact_id: "9007199254740993",
              source: "db",
              schema_name: "public",
              table_name: "invoice",
              table_oid: 16384,
              op: "UPDATE",
              record_id: { id: 7 },
              before: { id: 7, status: "open" },
              after: { id: 7, status: "paid" },
              changed: ["status"],
              actor: { type: "user", id: "u_1" },
              context: null,
              actor_source: "comment",
              db_user: "app_user",
              schema_version: 1,
            },
          ],
        };
      },
      { table: "invoice", recordId: { id: 7 }, schema: "custom_audit_2" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('FROM "custom_audit_2"."changes"');
    expect(calls[0]?.text).toContain("WHERE table_name = $1::text AND record_id = $2::jsonb");
    expect(calls[0]?.text).toContain("ORDER BY occurred_at DESC, id DESC LIMIT $3::int");
    expect(calls[0]?.values).toEqual(["invoice", '{"id":7}', 50]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "42",
      xact_id: "9007199254740993",
      op: "UPDATE",
      actor_source: "comment",
      schema_version: 1,
    });
  });

  it("rejects invalid schema names and invalid limits before sending any SQL", async () => {
    let called = false;
    const exec = () => {
      called = true;
      return [];
    };

    const badSchemas = ["", "1bad", "AuditStream", 'audit"; DROP TABLE x;--', "a-b", "a.b"];
    for (const schema of badSchemas) {
      await expect(
        audit.history(exec, { table: "invoice", recordId: { id: 1 }, schema }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    }

    for (const limit of [0, -1, 1001, 1.5, Number.NaN]) {
      await expect(
        audit.history(exec, { table: "invoice", recordId: { id: 1 }, limit }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    }

    expect(called).toBe(false);
  });
});
