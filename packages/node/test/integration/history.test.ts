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
});
