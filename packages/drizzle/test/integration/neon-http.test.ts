import { audit, setConfigValue } from "@auditstream/node";
import {
  createTestDatabase,
  type NeonProxyInstance,
  startNeonProxy,
  stopTestCluster,
  type TestDatabase,
} from "@auditstream/test-utils";
import { neon, neonConfig } from "@neondatabase/serverless";
import { eq as eq045 } from "drizzle-orm";
import { drizzle as drizzle045 } from "drizzle-orm/neon-http";
import { integer as int045, pgTable as pgTable045, text as text045 } from "drizzle-orm/pg-core";
import { eq as eqV1 } from "drizzle-orm-v1";
import { drizzle as drizzleV1 } from "drizzle-orm-v1/neon-http";
import { integer as intV1, pgTable as pgTableV1, text as textV1 } from "drizzle-orm-v1/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapNeonHttp } from "../../src/neon-http.js";

const invoice045 = pgTable045("invoice", {
  id: int045("id").primaryKey(),
  status: text045("status"),
});

const invoiceV1 = pgTableV1("invoice", {
  id: intV1("id").primaryKey(),
  status: textV1("status"),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("wrapNeonHttp() + Drizzle 0.45 and 1.x Neon HTTP integration", () => {
  let db: TestDatabase;
  let proxy: NeonProxyInstance;
  let adminClient: pg.Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    proxy = await startNeonProxy({ database: db.database });
    neonConfig.fetchEndpoint = proxy.fetchEndpoint;

    // Wait for local-neon-http-proxy's upstream Postgres backend to finish initializing
    // (TCP port 4444 opens slightly before /sql stops returning HTTP 502).
    const probeSql = neon(proxy.urlFor(db.database));
    let lastErr: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await probeSql.query("SELECT 1");
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(100);
      }
    }
    if (lastErr !== undefined) {
      throw lastErr;
    }

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

  async function fetchInvoiceRows(startId: string) {
    return (
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
  }

  it("captures insert, update, delete, and db.batch([update, delete]) with Drizzle 0.45", async () => {
    const startId = await resetAuditState();
    const sql = wrapNeonHttp(neon(proxy.urlFor(db.database)));
    const orm = drizzle045({ client: sql });

    await audit.as({ type: "user", id: "nh45_insert" }, () =>
      orm.insert(invoice045).values([
        { id: 1, status: "a" },
        { id: 2, status: "b" },
      ]),
    );
    await audit.as({ type: "user", id: "nh45_update" }, () =>
      orm.update(invoice045).set({ status: "u1" }).where(eq045(invoice045.id, 1)),
    );
    await audit.as({ type: "user", id: "nh45_batch" }, () =>
      orm.batch([
        orm.update(invoice045).set({ status: "batched" }).where(eq045(invoice045.id, 1)),
        orm.delete(invoice045).where(eq045(invoice045.id, 2)),
      ]),
    );
    await audit.as({ type: "user", id: "nh45_delete" }, () =>
      orm.delete(invoice045).where(eq045(invoice045.id, 1)),
    );

    const rows = await fetchInvoiceRows(startId);
    expect(rows).toEqual([
      { op: "INSERT", pk: 1, actor_id: "nh45_insert", actor_source: "comment" },
      { op: "INSERT", pk: 2, actor_id: "nh45_insert", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: "nh45_update", actor_source: "comment" },
      { op: "UPDATE", pk: 1, actor_id: "nh45_batch", actor_source: "comment" },
      { op: "DELETE", pk: 2, actor_id: "nh45_batch", actor_source: "comment" },
      { op: "DELETE", pk: 1, actor_id: "nh45_delete", actor_source: "comment" },
    ]);
  });

  it("captures insert, update, delete, and db.batch([update, delete]) with Drizzle 1.x", async () => {
    const startId = await resetAuditState();
    const sql = wrapNeonHttp(neon(proxy.urlFor(db.database)));
    const orm = drizzleV1({ client: sql });

    await audit.as({ type: "user", id: "nhv1_insert" }, () =>
      orm.insert(invoiceV1).values([
        { id: 10, status: "a" },
        { id: 11, status: "b" },
      ]),
    );
    await audit.as({ type: "user", id: "nhv1_update" }, () =>
      orm.update(invoiceV1).set({ status: "u1" }).where(eqV1(invoiceV1.id, 10)),
    );
    await audit.as({ type: "user", id: "nhv1_batch" }, () =>
      orm.batch([
        orm.update(invoiceV1).set({ status: "batched" }).where(eqV1(invoiceV1.id, 10)),
        orm.delete(invoiceV1).where(eqV1(invoiceV1.id, 11)),
      ]),
    );
    await audit.as({ type: "user", id: "nhv1_delete" }, () =>
      orm.delete(invoiceV1).where(eqV1(invoiceV1.id, 10)),
    );

    const rows = await fetchInvoiceRows(startId);
    expect(rows).toEqual([
      { op: "INSERT", pk: 10, actor_id: "nhv1_insert", actor_source: "comment" },
      { op: "INSERT", pk: 11, actor_id: "nhv1_insert", actor_source: "comment" },
      { op: "UPDATE", pk: 10, actor_id: "nhv1_update", actor_source: "comment" },
      { op: "UPDATE", pk: 10, actor_id: "nhv1_batch", actor_source: "comment" },
      { op: "DELETE", pk: 11, actor_id: "nhv1_batch", actor_source: "comment" },
      { op: "DELETE", pk: 10, actor_id: "nhv1_delete", actor_source: "comment" },
    ]);
  });

  it("leak check: HTTP transaction with set_config followed by a plain query stores set_config then NULL", async () => {
    const startId = await resetAuditState();
    const sql = wrapNeonHttp(neon(proxy.urlFor(db.database)));

    await sql.query("INSERT INTO invoice (id, status) VALUES ($1, $2)", [50, "seed"]);

    const actorPayload = setConfigValue({ actor: { type: "user", id: "nh_setcfg" } });
    await sql.transaction([
      sql.query("SELECT set_config('auditstream.actor', $1, true)", [actorPayload]),
      sql.query("UPDATE invoice SET status = $1 WHERE id = $2", ["in_tx", 50]),
    ]);

    await sql.query("UPDATE invoice SET status = $1 WHERE id = $2", ["after_tx", 50]);

    const rows = await fetchInvoiceRows(startId);
    expect(rows).toEqual([
      { op: "INSERT", pk: 50, actor_id: null, actor_source: null },
      { op: "UPDATE", pk: 50, actor_id: "nh_setcfg", actor_source: "set_config" },
      { op: "UPDATE", pk: 50, actor_id: null, actor_source: null },
    ]);
  });

  it("40 concurrent requests with distinct actors over Neon HTTP produce zero wrong actors", async () => {
    const startId = await resetAuditState();
    const sql = wrapNeonHttp(neon(proxy.urlFor(db.database)));
    const orm = drizzle045({ client: sql });

    const ids = Array.from({ length: 40 }, (_, i) => i);
    await orm.insert(invoice045).values(ids.map((i) => ({ id: 100 + i, status: "seed" })));

    await Promise.all(
      ids.map((i) =>
        audit.as({ type: "user", id: `nhc_${i}` }, async () => {
          await sleep((i * 7) % 19);
          await orm
            .update(invoice045)
            .set({ status: `nhc_${i}` })
            .where(eq045(invoice045.id, 100 + i));
        }),
      ),
    );

    const rows = await fetchInvoiceRows(startId);
    const updates = rows.filter((r) => r.op === "UPDATE");
    expect(updates).toHaveLength(40);
    for (const row of updates) {
      expect(row.actor_source).toBe("comment");
      expect(row.actor_id).toBe(`nhc_${row.pk - 100}`);
    }
  });
});
