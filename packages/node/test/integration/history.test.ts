import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, tagSql } from "../../src/index.js";

describe("audit.history() live Postgres integration", () => {
  let db: TestDatabase;
  let appPool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    appPool = new pg.Pool({ connectionString: db.appUrl, max: 4 });
  });

  afterAll(async () => {
    await appPool?.end();
    await db?.drop();
    await stopTestCluster();
  });

  it("reads typed history rows written by prototype triggers for three records newest-first as app_user", async () => {
    // Write changes across three distinct invoice records (ids 10, 20, 30) as app_user.
    await audit.as({ type: "user", id: "u_create" }, async () => {
      await appPool.query(
        tagSql(
          "INSERT INTO invoice (id, status, total) VALUES (10, 'draft', 100), (20, 'open', 200), (30, 'open', 300)",
        ),
      );
    });

    await audit.as({ type: "user", id: "u_pay" }, async () => {
      await appPool.query(tagSql("UPDATE invoice SET status = 'paid' WHERE id = 10"));
    });

    await audit.as(
      { type: "ai_agent", id: "close-bot", onBehalfOf: { type: "user", id: "u_42" } },
      async () => {
        await appPool.query(tagSql("UPDATE invoice SET total = 150 WHERE id = 10"));
      },
    );

    await audit.as({ type: "user", id: "u_cancel" }, async () => {
      await appPool.query(tagSql("DELETE FROM invoice WHERE id = 20"));
    });

    const exec = (text: string, values: [string, string, number]) => appPool.query(text, values);

    // Record 10: 3 events newest first (UPDATE total=150, UPDATE status=paid, INSERT).
    const h10 = await audit.history(exec, { table: "invoice", recordId: { id: 10 } });
    expect(h10).toHaveLength(3);
    expect(h10.map((e) => e.op)).toEqual(["UPDATE", "UPDATE", "INSERT"]);
    expect(h10[0]?.actor).toMatchObject({
      type: "ai_agent",
      id: "close-bot",
      onBehalfOf: { type: "user", id: "u_42" },
    });
    expect(h10[0]?.actor_source).toBe("comment");
    expect(h10[0]?.changed).toEqual(["total"]);
    expect(h10[1]?.actor).toMatchObject({ type: "user", id: "u_pay" });
    expect(h10[2]?.actor).toMatchObject({ type: "user", id: "u_create" });
    for (const entry of h10) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.xact_id).toBe("string");
      expect(entry.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(entry.source).toBe("db");
      expect(entry.table_name).toBe("invoice");
      expect(entry.db_user).toBe("app_user");
      expect(entry.schema_version).toBe(1);
    }

    // Record 10 with limit: 2 returns only the 2 newest rows.
    const h10Limited = await audit.history(exec, {
      table: "invoice",
      recordId: { id: 10 },
      limit: 2,
    });
    expect(h10Limited).toHaveLength(2);
    expect(h10Limited.map((e) => e.id)).toEqual([h10[0]?.id, h10[1]?.id]);

    // Record 20: DELETE then INSERT (newest first).
    const h20 = await audit.history(exec, { table: "invoice", recordId: { id: 20 } });
    expect(h20.map((e) => e.op)).toEqual(["DELETE", "INSERT"]);
    expect(h20[0]?.actor).toMatchObject({ type: "user", id: "u_cancel" });

    // Record 30: single INSERT.
    const h30 = await audit.history(exec, { table: "invoice", recordId: { id: 30 } });
    expect(h30.map((e) => e.op)).toEqual(["INSERT"]);
    expect(h30[0]?.actor).toMatchObject({ type: "user", id: "u_create" });
  });

  it("orders same-microsecond ties numerically across power-of-10 id boundaries and custom schemas without text-alias sorts", async () => {
    const adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
    try {
      await adminClient.query(
        `INSERT INTO auditstream.changes
           (id, occurred_at, source, schema_name, table_name, op, record_id)
         OVERRIDING SYSTEM VALUE VALUES
           (99,  date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'INSERT', '{"id":999}'::jsonb),
           (100, date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'UPDATE', '{"id":999}'::jsonb),
           (101, date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'UPDATE', '{"id":999}'::jsonb)`,
      );

      // Also seed a non-default schema outside search_path to prove `changes.*` resolves cleanly.
      await adminClient.query(`
        CREATE SCHEMA custom_audit;
        CREATE TABLE custom_audit.changes (LIKE auditstream.changes INCLUDING DEFAULTS INCLUDING IDENTITY INCLUDING CONSTRAINTS);
        INSERT INTO custom_audit.changes
          (id, occurred_at, source, schema_name, table_name, op, record_id)
        OVERRIDING SYSTEM VALUE VALUES
          (9,  date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'INSERT', '{"id":999}'::jsonb),
          (10, date_trunc('second', now()) + interval '123456 microseconds', 'db', 'public', 'tie_invoice', 'UPDATE', '{"id":999}'::jsonb);
        GRANT USAGE ON SCHEMA custom_audit TO app_user;
        GRANT SELECT ON custom_audit.changes TO app_user;
      `);
    } finally {
      await adminClient.end();
    }

    let capturedSql = "";
    let capturedValues: [string, string, number] = ["", "", 0];
    const exec = (text: string, values: [string, string, number]) => {
      capturedSql = text;
      capturedValues = values;
      return appPool.query(text, values);
    };

    const entries = await audit.history(exec, { table: "tie_invoice", recordId: { id: 999 } });
    expect(entries.map((e) => e.id)).toEqual(["101", "100", "99"]);
    expect(entries[0]?.occurred_at).toMatch(/\.123456Z$/);

    const planResult = await appPool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (FORMAT TEXT) ${capturedSql}`,
      capturedValues,
    );
    const planText = planResult.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(planText).not.toMatch(/Sort Key:.*(to_char\(|::text)/i);

    const customEntries = await audit.history(exec, {
      schema: "custom_audit",
      table: "tie_invoice",
      recordId: { id: 999 },
    });
    expect(customEntries.map((e) => e.id)).toEqual(["10", "9"]);
  });
});
