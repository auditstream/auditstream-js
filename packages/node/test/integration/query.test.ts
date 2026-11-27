import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuditQueryValues, audit, tagSql } from "../../src/index.js";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_EVENT_FIXTURE_SQL = readFileSync(resolve(FIXTURE_DIR, "fixtures/log-event.sql"), "utf8");

describe("audit.query() live Postgres integration", () => {
  let db: TestDatabase;
  let adminClient: pg.Client;
  let appPool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
    await adminClient.query(LOG_EVENT_FIXTURE_SQL);
    appPool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminClient?.end();
    await db?.drop();
    await stopTestCluster();
  });

  it("queries app events, filters by tenant/actor/opPrefix safely, and paginates keyset without duplicates", async () => {
    const logExec = (text: string, values: [string, string | null, string | null]) =>
      appPool.query(tagSql(text), values);

    // 1. Seed DB changes and app events across two tenants and literal wildcard op names.
    await audit.as({ type: "user", id: "u_acme_1", tenant: "org_acme" }, async () => {
      await appPool.query(
        tagSql(
          "INSERT INTO invoice (id, status, total) VALUES (101, 'draft', 10), (102, 'draft', 20), (103, 'draft', 30)",
        ),
      );
      await audit.log(logExec, {
        action: "invoice.exported",
        target: { invoice_id: 101 },
        data: { format: "csv" },
      });
      await audit.log(logExec, {
        action: "inv%_literal.run",
        target: { invoice_id: 101 },
        data: { ok: true },
      });
    });

    await audit.as(
      {
        type: "ai_agent",
        id: "bot_billing",
        onBehalfOf: { type: "user", id: "u_acme_2", tenant: "org_acme" },
      },
      async () => {
        await audit.log(logExec, {
          action: "invoice.sent",
          target: { invoice_id: 102 },
          data: { channel: "email" },
        });
      },
    );

    await audit.as({ type: "user", id: "u_beta_1", tenant: "org_beta" }, async () => {
      await audit.log(logExec, {
        action: "invXXliteral.run",
        target: { invoice_id: 200 },
        data: { other: true },
      });
    });

    // pg-style { rows } executor
    const pgExec = (text: string, values: AuditQueryValues) => appPool.query(text, values);
    // postgres.js / Neon / Prisma-style row-array executor
    const arrayExec = async (text: string, values: AuditQueryValues) =>
      (await appPool.query(text, values)).rows;

    // 2. Query back `audit.log()` app events (table_name IS NULL) for org_acme (direct + onBehalfOf).
    const acmeApp = await audit.query(pgExec, {
      source: "app",
      tenant: "org_acme",
      unbounded: true,
    });
    expect(acmeApp.hasMore).toBe(false);
    expect(acmeApp.nextCursor).toBeNull();
    expect(acmeApp.entries.map((e) => e.op)).toEqual([
      "invoice.sent",
      "inv%_literal.run",
      "invoice.exported",
    ]);
    for (const entry of acmeApp.entries) {
      expect(entry.source).toBe("app");
      expect(entry.table_name).toBeNull();
      expect(entry.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    }

    // 3. `opPrefix` uses pg_catalog.starts_with so `%` and `_` are literal, NOT LIKE wildcards.
    const literalPrefix = await audit.query(arrayExec, {
      opPrefix: "inv%_",
      unbounded: true,
    });
    expect(literalPrefix.entries.map((e) => e.op)).toEqual(["inv%_literal.run"]);

    // 4. Keyset pagination across all org_acme events (including multi-row INSERT ties) with limit=2.
    const seenIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await audit.query(pgExec, {
        tenant: "org_acme",
        unbounded: true,
        limit: 2,
        cursor,
      });
      pages += 1;
      for (const entry of page.entries) {
        seenIds.push(entry.id);
      }
      cursor = page.nextCursor ?? undefined;
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
    } while (pages < 10);

    // 3 DB INSERT rows + 3 app events = 6 unique org_acme events across 3 pages.
    expect(pages).toBe(3);
    expect(seenIds).toHaveLength(6);
    expect(new Set(seenIds).size).toBe(6);
  });

  it("paginates same-microsecond ties numerically across power-of-10 id boundaries without dropping rows or text-alias sorts", async () => {
    await adminClient.query(
      `INSERT INTO auditstream.changes
         (id, occurred_at, source, schema_name, table_name, op, record_id)
       OVERRIDING SYSTEM VALUE VALUES
         (999,  date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'INSERT', '{"id":777}'::jsonb),
         (1000, date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'UPDATE', '{"id":777}'::jsonb),
         (1001, date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'UPDATE', '{"id":777}'::jsonb)`,
    );

    let firstPageSql = "";
    let firstPageValues: AuditQueryValues = [];
    const pgExec = (text: string, values: AuditQueryValues) => {
      if (firstPageSql === "") {
        firstPageSql = text;
        firstPageValues = [...values];
      }
      return appPool.query(text, values);
    };
    const seenIds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await audit.query(pgExec, {
        table: "tie_invoice",
        recordId: { id: 777 },
        limit: 1,
        cursor,
      });
      pages += 1;
      for (const entry of page.entries) {
        expect(entry.occurred_at).toMatch(/\.123456Z$/);
        seenIds.push(entry.id);
      }
      cursor = page.nextCursor ?? undefined;
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
    } while (pages < 10);

    expect(pages).toBe(3);
    expect(seenIds).toEqual(["1001", "1000", "999"]);

    const planResult = await appPool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (FORMAT TEXT) ${firstPageSql}`,
      firstPageValues,
    );
    const planText = planResult.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(planText).not.toMatch(/Sort Key:.*(to_char\(|::text)/i);
  });
});
