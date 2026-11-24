import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import { type ServerType, serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createDatabase, type DatabaseHandle } from "../src/db.js";
import type { InvoiceRecord, LineItemRecord } from "../src/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(__dirname, "../drizzle");

interface AuditChangeRow {
  readonly table_name: string;
  readonly op: string;
  readonly pk: number;
  readonly status: string | null;
  readonly description: string | null;
  readonly actor_id: string | null;
  readonly actor_source: string | null;
}

interface FinalizeResponse {
  readonly invoice: InvoiceRecord;
  readonly lineItem: LineItemRecord;
  readonly rolledBackOptionalItem: boolean;
}

async function startServerOnFreePort(app: ReturnType<typeof createApp>): Promise<{
  server: ServerType;
  baseUrl: string;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${info.port}` });
    });
    server.once("error", rejectPromise);
    const addr = server.address() as AddressInfo | null;
    if (addr && typeof addr === "object" && addr.port > 0) {
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    }
  });
}

async function fetchChangesSince(admin: pg.Client, sinceId: string): Promise<AuditChangeRow[]> {
  const res = await admin.query<AuditChangeRow>(
    `SELECT table_name,
            op,
            (record_id->>'id')::int AS pk,
            coalesce(after->>'status', before->>'status') AS status,
            coalesce(after->>'description', before->>'description') AS description,
            actor->>'id' AS actor_id,
            actor_source
       FROM auditstream.changes
      WHERE id > $1
        AND table_name IN ('invoice', 'line_item')
      ORDER BY id ASC`,
    [sinceId],
  );
  return res.rows;
}

async function getLatestChangeId(admin: pg.Client): Promise<string> {
  const res = await admin.query<{ m: string }>(
    "SELECT coalesce(max(id), 0)::text AS m FROM auditstream.changes",
  );
  return res.rows[0]?.m ?? "0";
}

describe("examples/hono-drizzle smoke test", () => {
  let db: TestDatabase;
  let admin: pg.Client;
  let appDb: DatabaseHandle;
  let server: ServerType;
  let baseUrl: string;

  beforeAll(async () => {
    db = await createTestDatabase();

    // Strip the prototype schema so the real engine-generated Drizzle migrations run cleanly.
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS auditstream CASCADE;");
    await admin.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await admin.query("DROP TABLE IF EXISTS public.line_item, public.invoice CASCADE;");

    const migratePool = new pg.Pool({ connectionString: db.adminUrl, max: 1 });
    try {
      await migrate(drizzle({ client: migratePool }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await migratePool.end();
    }

    appDb = createDatabase(db.appUrl, 5);
    const app = createApp(appDb.db);
    const started = await startServerOnFreePort(app);
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
    }
    await appDb?.close();
    await admin?.end();
    await db?.drop();
    await stopTestCluster();
  });

  it("captures create, update, savepoint transaction, and delete routes with request actors", async () => {
    const startId = await getLatestChangeId(admin);

    // 1. Create invoice
    const createRes = await fetch(`${baseUrl}/invoices`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "alice",
        "x-request-id": "req-create-1",
      },
      body: JSON.stringify({ status: "draft", total: "50.00" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as InvoiceRecord;

    // 2. Update invoice
    const updateRes = await fetch(`${baseUrl}/invoices/${created.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "bob",
      },
      body: JSON.stringify({ status: "review", total: "125.00" }),
    });
    expect(updateRes.status).toBe(200);

    // 3. Finalize in a Drizzle transaction with a nested savepoint (+ rolled-back savepoint)
    const finalizeRes = await fetch(`${baseUrl}/invoices/${created.id}/finalize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "carol",
      },
      body: JSON.stringify({
        description: "Annual subscription",
        amount: "250.00",
        simulateRollback: true,
      }),
    });
    expect(finalizeRes.status).toBe(200);
    const finalized = (await finalizeRes.json()) as FinalizeResponse;
    expect(finalized.invoice.status).toBe("finalized");
    expect(finalized.lineItem.description).toBe("Annual subscription");
    expect(finalized.rolledBackOptionalItem).toBe(true);

    // 4. Delete invoice (cascades line_item)
    const deleteRes = await fetch(`${baseUrl}/invoices/${created.id}`, {
      method: "DELETE",
      headers: { "x-demo-user": "dave" },
    });
    expect(deleteRes.status).toBe(200);

    const rows = await fetchChangesSince(admin, startId);
    expect(rows).toEqual([
      {
        table_name: "invoice",
        op: "INSERT",
        pk: created.id,
        status: "draft",
        description: null,
        actor_id: "alice",
        actor_source: "comment",
      },
      {
        table_name: "invoice",
        op: "UPDATE",
        pk: created.id,
        status: "review",
        description: null,
        actor_id: "bob",
        actor_source: "comment",
      },
      {
        table_name: "invoice",
        op: "UPDATE",
        pk: created.id,
        status: "finalized",
        description: null,
        actor_id: "carol",
        actor_source: "comment",
      },
      {
        table_name: "line_item",
        op: "INSERT",
        pk: finalized.lineItem.id,
        status: null,
        description: "Annual subscription",
        actor_id: "carol",
        actor_source: "comment",
      },
      {
        table_name: "invoice",
        op: "DELETE",
        pk: created.id,
        status: "finalized",
        description: null,
        actor_id: "dave",
        actor_source: "comment",
      },
      {
        table_name: "line_item",
        op: "DELETE",
        pk: finalized.lineItem.id,
        status: null,
        description: "Annual subscription",
        actor_id: "dave",
        actor_source: "comment",
      },
    ]);
  });

  it("handles 40 concurrent requests with distinct demo users through a pool of 5 with zero wrong actors", async () => {
    const startId = await getLatestChangeId(admin);
    const count = 40;
    const indices = Array.from({ length: count }, (_, i) => i);

    const responses = await Promise.all(
      indices.map(async (i) => {
        const userId = `demo-user-${i}`;
        const res = await fetch(`${baseUrl}/invoices`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-demo-user": userId,
          },
          body: JSON.stringify({ status: userId, total: `${100 + i}.00` }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as InvoiceRecord;
        return { id: body.id, userId };
      }),
    );

    const rows = await fetchChangesSince(admin, startId);
    expect(rows).toHaveLength(count);

    const byPk = new Map<number, AuditChangeRow>(rows.map((r) => [r.pk, r]));
    let wrongActors = 0;

    for (const { id, userId } of responses) {
      const row = byPk.get(id);
      expect(row).toBeDefined();
      expect(row?.op).toBe("INSERT");
      expect(row?.status).toBe(userId);
      expect(row?.actor_source).toBe("comment");
      if (row?.actor_id !== userId) {
        wrongActors += 1;
      }
    }

    expect(wrongActors).toBe(0);
  });

  it("writes the row with NULL actor when x-demo-user is omitted", async () => {
    const startId = await getLatestChangeId(admin);

    const res = await fetch(`${baseUrl}/invoices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "unscoped", total: "19.99" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as InvoiceRecord;

    const rows = await fetchChangesSince(admin, startId);
    expect(rows).toEqual([
      {
        table_name: "invoice",
        op: "INSERT",
        pk: created.id,
        status: "unscoped",
        description: null,
        actor_id: null,
        actor_source: null,
      },
    ]);
  });
});
