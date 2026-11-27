import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AuditLogExecutor, audit, tagSql } from "../../src/index.js";
import { wrapPgPool } from "../../src/pg.js";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const LOG_EVENT_FIXTURE_SQL = readFileSync(resolve(FIXTURE_DIR, "fixtures/log-event.sql"), "utf8");

/**
 * Wraps a pg.Pool the same way docs/handbook/test-kit/js/common.ts does:
 * reads the active actor at call entry (before pg-pool queues the query across connections)
 * and appends the trailing sqlcommenter tag without using a named prepared statement.
 */
function createTaggedPoolExecutor(pool: pg.Pool): AuditLogExecutor {
  return (text, values) => {
    const tagged = tagSql(text, audit.current());
    return pool.query({ text: tagged, values });
  };
}

describe("audit.log() Postgres integration", () => {
  let db: TestDatabase;
  let adminClient: pg.Client;
  let appPool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
    await adminClient.query(LOG_EVENT_FIXTURE_SQL);

    appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminClient?.end();
    await db?.drop();
    await stopTestCluster();
  });

  it("installs fixture auditstream.log_event as SECURITY DEFINER owned by auditstream_owner with safe search_path", async () => {
    const res = await adminClient.query<{
      prosecdef: boolean;
      owner: string;
      proconfig: string[] | null;
    }>(
      `SELECT p.prosecdef, r.rolname AS owner, p.proconfig
         FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
        WHERE n.nspname = 'auditstream'
          AND p.proname = 'log_event'`,
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.prosecdef).toBe(true);
    expect(res.rows[0]?.owner).toBe("auditstream_owner");
    expect(res.rows[0]?.proconfig).toContain("search_path=pg_catalog, pg_temp");
  });

  it("writes 40 concurrent app rows through a pg Pool of 5 with zero wrong actors", async () => {
    const exec = createTaggedPoolExecutor(appPool);
    const total = 40;

    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        audit.as(
          { type: "user", id: `usr_${index}`, tenant: `org_${index % 4}` },
          async () => {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, (index * 7) % 19));
            const result = await audit.log(exec, {
              action: "invoice.sent",
              target: { invoiceId: index },
              data: { seq: index, channel: "email" },
            });
            expect(result).toBeUndefined();
          },
          { context: { requestId: `req_${index}`, source: "api" } },
        ),
      ),
    );

    const rows = (
      await adminClient.query<{
        source: string;
        schema_name: string | null;
        table_name: string | null;
        table_oid: number | null;
        op: string;
        record_id: { invoiceId: number } | null;
        before: unknown;
        after: { seq: number; channel: string } | null;
        changed: string[] | null;
        actor: { type: string; id: string; tenant?: string } | null;
        context: { requestId?: string; source?: string } | null;
        actor_source: string | null;
        db_user: string;
        schema_version: number;
      }>(
        `SELECT source, schema_name, table_name, table_oid, op, record_id, before, after,
                changed, actor, context, actor_source, db_user, schema_version
           FROM auditstream.changes
          WHERE source = 'app' AND op = 'invoice.sent'
          ORDER BY (record_id->>'invoiceId')::int ASC`,
      )
    ).rows;

    expect(rows).toHaveLength(total);
    for (let i = 0; i < total; i += 1) {
      const row = rows[i];
      expect(row).toBeDefined();
      expect(row?.source).toBe("app");
      expect(row?.schema_name).toBeNull();
      expect(row?.table_name).toBeNull();
      expect(row?.table_oid).toBeNull();
      expect(row?.op).toBe("invoice.sent");
      expect(row?.record_id).toEqual({ invoiceId: i });
      expect(row?.before).toBeNull();
      expect(row?.after).toEqual({ seq: i, channel: "email" });
      expect(row?.changed).toBeNull();
      expect(row?.actor).toEqual({ type: "user", id: `usr_${i}`, tenant: `org_${i % 4}` });
      expect(row?.context).toEqual({ requestId: `req_${i}`, source: "api" });
      expect(row?.actor_source).toBe("comment");
      expect(row?.db_user).toBe("app_user");
      expect(row?.schema_version).toBe(1);
    }
  });

  it("records actor as NULL outside any scope and keeps auditstream.changes unwritable by app_user", async () => {
    const exec = createTaggedPoolExecutor(appPool);

    expect(audit.current()).toBeUndefined();
    await audit.log(exec, {
      action: "system.heartbeat",
      target: { job: "nightly" },
      data: { ok: true },
    });

    const rows = (
      await adminClient.query<{
        source: string;
        op: string;
        record_id: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        actor: unknown;
        context: unknown;
        actor_source: string | null;
        db_user: string;
      }>(
        `SELECT source, op, record_id, after, actor, context, actor_source, db_user
           FROM auditstream.changes
          WHERE source = 'app' AND op = 'system.heartbeat'`,
      )
    ).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      source: "app",
      op: "system.heartbeat",
      record_id: { job: "nightly" },
      after: { ok: true },
      actor: null,
      context: null,
      actor_source: null,
      db_user: "app_user",
    });

    // app_user must never be able to INSERT directly into auditstream.changes.
    await expect(
      appPool.query("INSERT INTO auditstream.changes (op) VALUES ('spoof')"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("records actor user:usr_42 when running the packages/node README audit.log() snippet pattern", async () => {
    await audit.as({ type: "user", id: "usr_42" }, () =>
      audit.log((sql, values) => appPool.query(tagSql(sql), values), {
        action: "invoice.exported",
        target: { invoice_id: 42 },
        data: { format: "csv" },
      }),
    );

    const rows = (
      await adminClient.query<{
        op: string;
        record_id: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
        actor: Record<string, unknown> | null;
        actor_source: string | null;
      }>(
        `SELECT op, record_id, after, actor, actor_source
           FROM auditstream.changes
          WHERE source = 'app' AND op = 'invoice.exported'`,
      )
    ).rows;

    expect(rows).toEqual([
      {
        op: "invoice.exported",
        record_id: { invoice_id: 42 },
        after: { format: "csv" },
        actor: { type: "user", id: "usr_42" },
        actor_source: "comment",
      },
    ]);
  });

  it("tags 40 concurrent writes through @auditstream/node/pg wrapPgPool over a pool of 5 without drizzle-orm", async () => {
    const wrappedPool = wrapPgPool(new pg.Pool({ connectionString: db.appUrl, max: 5 }));
    const total = 40;

    try {
      await Promise.all(
        Array.from({ length: total }, (_, index) =>
          audit.as(
            { type: "user", id: `usr_pg_${index}`, tenant: `org_${index % 4}` },
            async () => {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, (index * 5) % 17));
              await audit.log((sql, values) => wrappedPool.query(sql, values), {
                action: "invoice.pg_wrapped",
                target: { seq: index },
              });
            },
          ),
        ),
      );
    } finally {
      await wrappedPool.end();
    }

    const rows = (
      await adminClient.query<{
        record_id: { seq: number };
        actor: { type: string; id: string; tenant?: string } | null;
        actor_source: string | null;
      }>(
        `SELECT record_id, actor, actor_source
           FROM auditstream.changes
          WHERE source = 'app' AND op = 'invoice.pg_wrapped'
          ORDER BY (record_id->>'seq')::int ASC`,
      )
    ).rows;

    expect(rows).toHaveLength(total);
    for (let i = 0; i < total; i += 1) {
      expect(rows[i]?.actor).toEqual({
        type: "user",
        id: `usr_pg_${i}`,
        tenant: `org_${i % 4}`,
      });
      expect(rows[i]?.actor_source).toBe("comment");
    }
  });
});
