import { audit } from "@auditstream/node";
import {
  createTestDatabase,
  type NeonProxyInstance,
  startNeonProxy,
  stopTestCluster,
  type TestDatabase,
} from "@auditstream/test-utils";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapPgPool } from "../../src/pg.js";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("wrapPgPool() + Drizzle 0.45 Neon WebSocket Pool integration", () => {
  let db: TestDatabase;
  let proxy: NeonProxyInstance;
  let adminClient: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    proxy = await startNeonProxy({ database: db.database });
    neonConfig.wsProxy = () => proxy.wsProxy;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;

    adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
  });

  afterAll(async () => {
    await adminClient?.end();
    await proxy?.stop();
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

  it("captures insert, transaction with savepoint, prepared statement, actor-less seed, and 40 concurrent writes over Neon WebSocket", async () => {
    const startId = await resetAuditState();
    const pool = wrapPgPool(new NeonPool({ connectionString: proxy.urlFor(db.database), max: 5 }));
    pool.on("error", () => {});
    const orm = drizzle({ client: pool });

    try {
      await audit.as({ type: "user", id: "d_insert" }, () =>
        orm.insert(invoice).values([
          { id: 1, status: "a" },
          { id: 2, status: "b" },
        ]),
      );

      await audit.as({ type: "user", id: "d_tx" }, () =>
        orm.transaction(async (tx) => {
          await tx.update(invoice).set({ status: "tx" }).where(eq(invoice.id, 1));
          await sleep(10);
          await tx.transaction(async (sp) => {
            await sp.delete(invoice).where(eq(invoice.id, 2));
          });
        }),
      );

      const prepared = orm
        .update(invoice)
        .set({ status: "prep" })
        .where(eq(invoice.id, 1))
        .prepare("upd1");
      await audit.as({ type: "user", id: "d_prepared" }, () => prepared.execute());

      const ids = Array.from({ length: 40 }, (_, i) => i);
      await orm.insert(invoice).values(ids.map((i) => ({ id: 100 + i, status: "new" })));

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

    expect(rows).toHaveLength(85);
    expect(rows.slice(0, 5)).toEqual([
      { op: "INSERT", pk: 1, actor_id: "d_insert", actor_source: "comment" },
      { op: "INSERT", pk: 2, actor_id: "d_insert", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: "d_tx", actor_source: "comment" },
      { op: "DELETE", pk: 2, actor_id: "d_tx", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: "d_prepared", actor_source: "comment" },
    ]);

    for (const row of rows.slice(5, 45)) {
      expect(row.op).toBe("INSERT");
      expect(row.actor_id).toBeNull();
      expect(row.actor_source).toBeNull();
    }

    for (const row of rows.slice(45)) {
      expect(row.op).toBe("UPDATE");
      expect(row.actor_source).toBe("comment");
      expect(row.actor_id).toBe(`k${row.pk - 100}`);
    }
  });

  it("interleaves 20 actor-less and 20 tagged updates through a Neon WebSocket pool of 2 with zero actor leaks", async () => {
    const startId = await resetAuditState();
    const pool = wrapPgPool(new NeonPool({ connectionString: proxy.urlFor(db.database), max: 2 }));
    pool.on("error", () => {});
    const orm = drizzle({ client: pool });

    try {
      const ids = Array.from({ length: 40 }, (_, i) => 200 + i);
      await orm.insert(invoice).values(ids.map((id) => ({ id, status: "seed" })));

      await Promise.all(
        ids.map((id, idx) => {
          if (idx % 2 === 0) {
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

  it("leaves zero auditstream= entries in pg_prepared_statements on Neon WebSocket pool of 1", async () => {
    await resetAuditState();
    const pool = wrapPgPool(new NeonPool({ connectionString: proxy.urlFor(db.database), max: 1 }));
    pool.on("error", () => {});
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
});
