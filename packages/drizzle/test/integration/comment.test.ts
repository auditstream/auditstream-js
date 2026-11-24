import { audit } from "@auditstream/node";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import { eq } from "drizzle-orm-v1";
import { drizzle } from "drizzle-orm-v1/node-postgres";
import { integer, pgTable, text } from "drizzle-orm-v1/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditComment } from "../../src/index.js";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("auditComment() + Drizzle 1.x plain pg.Pool integration (no wrapper)", () => {
  let db: TestDatabase;
  let adminClient: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
  });

  afterAll(async () => {
    await adminClient?.end();
    await db?.drop();
    await stopTestCluster();
  });

  async function resetAuditState(): Promise<string> {
    await adminClient.query("DELETE FROM line_item; DELETE FROM invoice;");
    const res = await adminClient.query<{ m: string }>(
      "SELECT coalesce(max(id), 0)::text AS m FROM auditstream.changes",
    );
    return res.rows[0]?.m ?? "0";
  }

  it("captures insert, update, delete, traceparent extra key, and unscoped writes on a plain pg.Pool", async () => {
    const startId = await resetAuditState();
    // Plain pg.Pool with NO Auditstream driver wrapper.
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const orm = drizzle({ client: pool });

    try {
      // 1. Insert with auditComment()
      await audit.as({ type: "user", id: "rc_insert" }, () =>
        orm
          .insert(invoice)
          .values([
            { id: 1, status: "open" },
            { id: 2, status: "open" },
          ])
          .comment(auditComment()),
      );

      // 2. Update with extra traceparent key alongside auditstream
      await audit.as({ type: "user", id: "rc_trace" }, () =>
        orm
          .update(invoice)
          .set({ status: "paid" })
          .where(eq(invoice.id, 1))
          .comment(
            auditComment({
              traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            }),
          ),
      );

      // 3. Delete with auditComment()
      await audit.as({ type: "user", id: "rc_delete" }, () =>
        orm.delete(invoice).where(eq(invoice.id, 2)).comment(auditComment()),
      );

      // 4. Outside any actor scope: auditComment() returns {} and leaves actor NULL
      await orm
        .update(invoice)
        .set({ status: "unscoped" })
        .where(eq(invoice.id, 1))
        .comment(auditComment());
    } finally {
      await pool.end();
    }

    const rows = (
      await adminClient.query<{
        op: string;
        pk: number;
        actor_id: string | null;
        actor_source: string | null;
      }>(
        `SELECT op, (record_id->>'id')::int AS pk, actor->>'id' AS actor_id, actor_source
           FROM auditstream.changes
          WHERE id > $1 AND table_name = 'invoice'
          ORDER BY id ASC`,
        [startId],
      )
    ).rows;

    expect(rows).toEqual([
      { op: "INSERT", pk: 1, actor_id: "rc_insert", actor_source: "comment" },
      { op: "INSERT", pk: 2, actor_id: "rc_insert", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: "rc_trace", actor_source: "comment" },
      { op: "DELETE", pk: 2, actor_id: "rc_delete", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: null, actor_source: null },
    ]);
  });

  it("40 concurrent requests with distinct actors through a plain pg.Pool of 5 produce zero wrong actors", async () => {
    const startId = await resetAuditState();
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const orm = drizzle({ client: pool });

    try {
      const ids = Array.from({ length: 40 }, (_, i) => i);
      await orm.insert(invoice).values(ids.map((i) => ({ id: 100 + i, status: "seed" })));

      await Promise.all(
        ids.map((i) =>
          audit.as({ type: "user", id: `rc_c${i}` }, async () => {
            await sleep((i * 7) % 19);
            await orm
              .update(invoice)
              .set({ status: `rc_c${i}` })
              .where(eq(invoice.id, 100 + i))
              .comment(
                auditComment({
                  traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4736-${String(i).padStart(16, "0")}-01`,
                }),
              );
          }),
        ),
      );
    } finally {
      await pool.end();
    }

    const updates = (
      await adminClient.query<{
        pk: number;
        actor_id: string | null;
        actor_source: string | null;
      }>(
        `SELECT (record_id->>'id')::int AS pk, actor->>'id' AS actor_id, actor_source
           FROM auditstream.changes
          WHERE id > $1 AND table_name = 'invoice' AND op = 'UPDATE'
          ORDER BY (record_id->>'id')::int ASC`,
        [startId],
      )
    ).rows;

    expect(updates).toHaveLength(40);
    for (const row of updates) {
      expect(row.actor_source).toBe("comment");
      expect(row.actor_id).toBe(`rc_c${row.pk - 100}`);
    }
  });
});
