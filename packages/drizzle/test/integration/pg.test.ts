import { audit, tagSql } from "@auditstream/node";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { eq as eqV1, sql as sqlV1 } from "drizzle-orm-v1";
import { drizzle as drizzleV1 } from "drizzle-orm-v1/node-postgres";
import { integer as integerV1, pgTable as pgTableV1, text as textV1 } from "drizzle-orm-v1/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditComment } from "../../src/comment.js";
import { wrapPgPool } from "../../src/pg.js";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const invoiceV1 = pgTableV1("invoice", {
  id: integerV1("id").primaryKey(),
  status: textV1("status"),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("wrapPgPool() + Drizzle 0.45 node-postgres integration", () => {
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

  it("captures insert, transaction with savepoint, prepared statement, actor-less seed, and 40 concurrent writes", async () => {
    const startId = await resetAuditState();
    const pool = wrapPgPool(new pg.Pool({ connectionString: db.appUrl, max: 5 }));
    const orm = drizzle({ client: pool });

    try {
      // 1. Insert with actor
      await audit.as({ type: "user", id: "d_insert" }, () =>
        orm.insert(invoice).values([
          { id: 1, status: "a" },
          { id: 2, status: "b" },
        ]),
      );

      // 2. Interactive transaction with nested savepoint
      await audit.as({ type: "user", id: "d_tx" }, () =>
        orm.transaction(async (tx) => {
          await tx.update(invoice).set({ status: "tx" }).where(eq(invoice.id, 1));
          await sleep(10);
          await tx.transaction(async (sp) => {
            await sp.delete(invoice).where(eq(invoice.id, 2));
          });
        }),
      );

      // 3. Prepared statement
      const prepared = orm
        .update(invoice)
        .set({ status: "prep" })
        .where(eq(invoice.id, 1))
        .prepare("upd1");
      await audit.as({ type: "user", id: "d_prepared" }, () => prepared.execute());

      // 4. Actor-less seed of 40 rows
      const ids = Array.from({ length: 40 }, (_, i) => i);
      await orm.insert(invoice).values(ids.map((i) => ({ id: 100 + i, status: "new" })));

      // 5. 40 concurrent updates with distinct actors through pool of 5
      await Promise.all(
        ids.map((i) =>
          audit.as({ type: "user", id: `k${i}` }, async () => {
            await sleep((i * 7) % 19);
            await orm
              .update(invoice)
              .set({ status: `k${i}` })
              .where(eq(invoice.id, 100 + i));
          }),
        ),
      );
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

    // 2 inserts + 1 tx update + 1 savepoint delete + 1 prepared update + 40 actor-less seeds + 40 concurrent updates = 85
    expect(rows).toHaveLength(85);

    expect(rows.slice(0, 5)).toEqual([
      { op: "INSERT", pk: 1, actor_id: "d_insert", actor_source: "comment" },
      { op: "INSERT", pk: 2, actor_id: "d_insert", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: "d_tx", actor_source: "comment" },
      { op: "DELETE", pk: 2, actor_id: "d_tx", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: "d_prepared", actor_source: "comment" },
    ]);

    const seedRows = rows.slice(5, 45);
    for (const row of seedRows) {
      expect(row.op).toBe("INSERT");
      expect(row.actor_id).toBeNull();
      expect(row.actor_source).toBeNull();
    }

    const concurrentRows = rows.slice(45);
    expect(concurrentRows).toHaveLength(40);
    for (const row of concurrentRows) {
      expect(row.op).toBe("UPDATE");
      expect(row.actor_source).toBe("comment");
      expect(row.actor_id).toBe(`k${row.pk - 100}`);
    }
  });

  it("interleaves 20 actor-less and 20 tagged updates through a pool of 2 with zero actor leaks", async () => {
    const startId = await resetAuditState();
    const pool = wrapPgPool(new pg.Pool({ connectionString: db.appUrl, max: 2 }));
    const orm = drizzle({ client: pool });

    try {
      const ids = Array.from({ length: 40 }, (_, i) => 200 + i);
      await orm.insert(invoice).values(ids.map((id) => ({ id, status: "seed" })));

      await Promise.all(
        ids.map((id, idx) => {
          if (idx % 2 === 0) {
            // Actor-less update interleaved with tagged updates on the saturated 2-conn pool.
            return (async () => {
              await sleep((idx * 3) % 11);
              await orm
                .update(invoice)
                .set({ status: `unscoped_${id}` })
                .where(eq(invoice.id, id));
            })();
          }
          return audit.as({ type: "user", id: `tagged_${id}` }, async () => {
            await sleep((idx * 5) % 13);
            await orm
              .update(invoice)
              .set({ status: `tagged_${id}` })
              .where(eq(invoice.id, id));
          });
        }),
      );
    } finally {
      await pool.end();
    }

    const updates = (
      await adminClient.query<{ pk: number; actor_id: string | null; actor_source: string | null }>(
        `SELECT (record_id->>'id')::int AS pk, actor->>'id' AS actor_id, actor_source
           FROM auditstream.changes
          WHERE id > $1 AND table_name = 'invoice' AND op = 'UPDATE'
          ORDER BY (record_id->>'id')::int ASC`,
        [startId],
      )
    ).rows;

    expect(updates).toHaveLength(40);
    for (let idx = 0; idx < 40; idx += 1) {
      const row = updates[idx];
      const id = 200 + idx;
      expect(row?.pk).toBe(id);
      if (idx % 2 === 0) {
        expect(row?.actor_id).toBeNull();
        expect(row?.actor_source).toBeNull();
      } else {
        expect(row?.actor_id).toBe(`tagged_${id}`);
        expect(row?.actor_source).toBe("comment");
      }
    }
  });

  it("leaves zero auditstream= entries in pg_prepared_statements after 40 actors run .prepare('upd1') on a pool of 1", async () => {
    await resetAuditState();
    const pool = wrapPgPool(new pg.Pool({ connectionString: db.appUrl, max: 1 }));
    const orm = drizzle({ client: pool });

    try {
      await orm.insert(invoice).values({ id: 500, status: "init" });
      const prepared = orm
        .update(invoice)
        .set({ status: sql`${sql.placeholder("status")}` })
        .where(eq(invoice.id, 500))
        .prepare("upd1");

      for (let i = 0; i < 40; i += 1) {
        await audit.as({ type: "user", id: `prep_${i}` }, () =>
          prepared.execute({ status: `v${i}` }),
        );
      }

      const prepRes = await pool.query<{ name: string; statement: string }>(
        "SELECT name, statement FROM pg_prepared_statements",
      );
      const leaked = prepRes.rows.filter((r) => r.statement.includes("auditstream="));
      expect(leaked).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it("leaves zero auditstream= entries in pg_prepared_statements for pre-tagged named queries (Drizzle 1.x .comment() + .prepare() and direct pool/client configs)", async () => {
    const startId = await resetAuditState();
    const pool = wrapPgPool(new pg.Pool({ connectionString: db.appUrl, max: 1 }));
    const ormV1 = drizzleV1({ client: pool });

    try {
      await ormV1.insert(invoiceV1).values({ id: 600, status: "init" });

      for (let i = 0; i < 40; i += 1) {
        await audit.as({ type: "user", id: `v1_pg_prep_${i}` }, async () => {
          const prepared = ormV1
            .update(invoiceV1)
            .set({ status: sqlV1`${sqlV1.placeholder("status")}` })
            .where(eqV1(invoiceV1.id, 600))
            .comment(auditComment())
            .prepare(`v1_upd_${i}`);
          await prepared.execute({ status: `s_${i}` });
        });
      }

      // Pre-tagged named query outside any active scope on both pool.query() and checked-out client.query().
      const preTaggedPool = tagSql("UPDATE invoice SET status = $1 WHERE id = $2", {
        actor: { type: "service", id: "pg_pre_pool" },
      });
      await pool.query({ text: preTaggedPool, values: ["pool_out", 600], name: "pre_pool_stmt" });

      const client = await pool.connect();
      try {
        const preTaggedClient = tagSql("UPDATE invoice SET status = $1 WHERE id = $2", {
          actor: { type: "service", id: "pg_pre_client" },
        });
        await client.query({
          text: preTaggedClient,
          values: ["client_out", 600],
          name: "pre_client_stmt",
        });
      } finally {
        client.release();
      }

      const prepRes = await pool.query<{ name: string; statement: string }>(
        "SELECT name, statement FROM pg_prepared_statements",
      );
      const leaked = prepRes.rows.filter((r) => r.statement.includes("auditstream="));
      expect(leaked).toEqual([]);
    } finally {
      await pool.end();
    }

    const updates = (
      await adminClient.query<{ actor_id: string | null; actor_source: string | null }>(
        `SELECT actor->>'id' AS actor_id, actor_source
           FROM auditstream.changes
          WHERE id > $1 AND table_name = 'invoice' AND op = 'UPDATE'
          ORDER BY id ASC`,
        [startId],
      )
    ).rows;

    expect(updates).toHaveLength(42);
    for (let i = 0; i < 40; i += 1) {
      expect(updates[i]).toEqual({ actor_id: `v1_pg_prep_${i}`, actor_source: "comment" });
    }
    expect(updates[40]).toEqual({ actor_id: "pg_pre_pool", actor_source: "comment" });
    expect(updates[41]).toEqual({ actor_id: "pg_pre_client", actor_source: "comment" });
  });
});
