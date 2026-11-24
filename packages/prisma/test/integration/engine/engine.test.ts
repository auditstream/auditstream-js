import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Actor, audit, encodeScope, type NestedActor } from "@auditstream/node";
import {
  createTestDatabase,
  type PgBouncerInstance,
  startPgBouncer,
  stopTestCluster,
  type TestDatabase,
} from "@auditstream/test-utils";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditstream,
  auditTransaction,
  type PrismaRawExecutor,
  type PrismaTransactionRunner,
  type SqlCommenterPlugin,
} from "../../../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(__dirname, "../../..");
const ENGINE_CONFIG_PATH = resolve(PACKAGE_DIR, "test/fixtures/engine/prisma.config.ts");
const PRISMA_BIN = resolve(PACKAGE_DIR, "node_modules/.bin/prisma");

interface InvoiceDelegate {
  create(args: {
    data: {
      id: number;
      status?: string;
      total?: number;
      passwordHash?: string;
      lineItems?: { create: Array<{ id: number; qty?: number }> };
    };
  }): Promise<unknown>;
  createMany(args: {
    data: Array<{ id: number; status?: string; total?: number; passwordHash?: string }>;
  }): Promise<unknown>;
  update(args: {
    where: { id: number };
    data: { status?: string; total?: number; passwordHash?: string };
  }): Promise<unknown>;
  updateMany(args: {
    where: { id: { in: number[] } };
    data: { status?: string; total?: number };
  }): Promise<unknown>;
  upsert(args: {
    where: { id: number };
    create: { id: number; status?: string; total?: number };
    update: { status?: string; total?: number };
  }): Promise<unknown>;
  delete(args: { where: { id: number } }): Promise<unknown>;
}

interface LineItemDelegate {
  update(args: { where: { id: number }; data: { qty?: number } }): Promise<unknown>;
  delete(args: { where: { id: number } }): Promise<unknown>;
}

interface EngineTxClient extends PrismaRawExecutor {
  readonly invoice: InvoiceDelegate;
  readonly lineItem: LineItemDelegate;
}

interface EnginePrismaClient
  extends EngineTxClient,
    PrismaTransactionRunner<EngineTxClient, { maxWait?: number; timeout?: number }> {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $transaction<T extends readonly Promise<unknown>[]>(operations: [...T]): Promise<unknown[]>;
  $transaction<T>(
    fn: (tx: EngineTxClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
  $disconnect(): Promise<void>;
}

type PrismaClientCtor = new (options: {
  adapter: unknown;
  comments?: readonly SqlCommenterPlugin[];
}) => EnginePrismaClient;

async function loadEnginePrismaClient(): Promise<PrismaClientCtor> {
  // Dynamic path prevents `tsc --noEmit` from requiring `prisma generate` on a clean checkout.
  const clientPath = "../generated/prisma-engine/client.ts";
  const mod = (await import(clientPath)) as { PrismaClient: PrismaClientCtor };
  return mod.PrismaClient;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function user(id: string): NestedActor {
  return { type: "user", id };
}

function runPrismaCli(args: readonly string[], databaseUrl?: string): void {
  execFileSync(PRISMA_BIN, [...args, "--config", ENGINE_CONFIG_PATH], {
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    },
    stdio: "pipe",
  });
}

async function prepareFreshMigratedDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase();
  // Strip prototype tables/schema without dropping cluster-wide roles (`app_user`, `auditstream_owner`),
  // then deploy the real app + engine migrations through `prisma migrate deploy`.
  const admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  try {
    await admin.query("DROP SCHEMA IF EXISTS auditstream CASCADE;");
    await admin.query("DROP TABLE IF EXISTS public.line_item, public.invoice CASCADE;");
    await admin.query("DROP TABLE IF EXISTS public._prisma_migrations CASCADE;");
  } finally {
    await admin.end();
  }

  runPrismaCli(["migrate", "deploy"], db.adminUrl);
  return db;
}

interface AuditRow {
  table_name: string;
  op: string;
  pk: string;
  actor_id: string | null;
  actor_type: string | null;
  on_behalf_of_id: string | null;
  req_id: string | null;
  actor_source: string | null;
  has_password_hash: boolean;
}

async function resetDataAndGetCursor(adminClient: pg.Client): Promise<string> {
  await adminClient.query("DELETE FROM public.line_item; DELETE FROM public.invoice;");
  const res = await adminClient.query<{ m: string }>(
    "SELECT coalesce(max(id), 0)::text AS m FROM auditstream.changes",
  );
  return res.rows[0]?.m ?? "0";
}

async function fetchAuditRows(adminClient: pg.Client, startId: string): Promise<AuditRow[]> {
  const res = await adminClient.query<AuditRow>(
    `SELECT table_name,
            op,
            record_id->>'id' AS pk,
            actor->>'id' AS actor_id,
            actor->>'type' AS actor_type,
            actor->'onBehalfOf'->>'id' AS on_behalf_of_id,
            context->>'requestId' AS req_id,
            actor_source,
            (coalesce(after ? 'password_hash', false) OR coalesce(before ? 'password_hash', false)) AS has_password_hash
       FROM auditstream.changes
      WHERE id > $1 AND table_name IN ('invoice', 'line_item')
      ORDER BY id ASC`,
    [startId],
  );
  return res.rows;
}

function assertExpectedMultiset(rows: readonly AuditRow[], expected: readonly string[]): void {
  const got = rows.map((r) => `${r.table_name} ${r.op} ${r.pk} ${r.actor_id ?? "-"}`);
  const left = [...got];
  const missing: string[] = [];

  for (const exp of expected) {
    const idx = left.indexOf(exp);
    if (idx >= 0) {
      left.splice(idx, 1);
    } else {
      missing.push(exp);
    }
  }

  expect({ missing, unexpected: left }).toEqual({ missing: [], unexpected: [] });
}

describe("@auditstream/prisma on real engine-generated migrations", () => {
  let PrismaClient: PrismaClientCtor;
  let db: TestDatabase;
  let adminClient: pg.Client;
  let pgbouncer: PgBouncerInstance;

  beforeAll(async () => {
    runPrismaCli(["generate"]);
    PrismaClient = await loadEnginePrismaClient();
    db = await prepareFreshMigratedDatabase();
    adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
    pgbouncer = await startPgBouncer({
      poolMode: "transaction",
      defaultPoolSize: 3,
      maxPreparedStatements: 200,
    });
  });

  afterAll(async () => {
    await pgbouncer?.stop();
    await adminClient?.end();
    await db?.drop();
    await stopTestCluster();
  });

  it("deploys app + engine migrations cleanly to a second fresh database in the same cluster without dropping roles", async () => {
    const secondDb = await prepareFreshMigratedDatabase();
    const client = new pg.Client({ connectionString: secondDb.adminUrl });
    await client.connect();
    try {
      const trigRes = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_catalog.pg_trigger t
           JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname IN ('invoice', 'line_item')
            AND t.tgname LIKE 'auditstream_%'
            AND NOT t.tgisinternal`,
      );
      expect(Number(trigRes.rows[0]?.count)).toBe(8);
    } finally {
      await client.end();
      await secondDb.drop();
    }
  });

  it("passes every JC1 scenario with the comments plugin on engine statement/row triggers and excludes password_hash", async () => {
    const startId = await resetDataAndGetCursor(adminClient);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter, comments: [auditstream()] });

    const agent: Actor = {
      type: "ai_agent",
      id: "billing-agent",
      onBehalfOf: user("u_42"),
    };
    const ids = Array.from({ length: 40 }, (_, i) => i);
    const expected: string[] = [];

    try {
      const probeActor = user("probe");
      const probeRows = await audit.as(probeActor, () =>
        prisma.$queryRawUnsafe<Array<{ q: string }>>("SELECT current_query() AS q"),
      );
      expect(
        probeRows[0]?.q
          .trimEnd()
          .endsWith(`/*auditstream='${encodeScope({ actor: probeActor })}'*/`),
      ).toBe(true);

      // 1. create (with excluded password_hash)
      await audit.as(user("u_create"), () =>
        prisma.invoice.create({
          data: { id: 1, status: "open", total: 10, passwordHash: "secret_hash_1" },
        }),
      );
      expected.push("invoice INSERT 1 u_create");

      // 2. nested create
      await audit.as(user("u_nested"), () =>
        prisma.invoice.create({
          data: {
            id: 2,
            status: "open",
            lineItems: {
              create: [
                { id: 20, qty: 1 },
                { id: 21, qty: 2 },
              ],
            },
          },
        }),
      );
      expected.push(
        "invoice INSERT 2 u_nested",
        "line_item INSERT 20 u_nested",
        "line_item INSERT 21 u_nested",
      );

      // 3. createMany (40 rows, statement-level INSERT trigger with transition table)
      await audit.as(user("u_many"), () =>
        prisma.invoice.createMany({
          data: ids.map((i) => ({ id: 1000 + i, status: "new", passwordHash: `secret_${i}` })),
        }),
      );
      for (const i of ids) {
        expected.push(`invoice INSERT ${1000 + i} u_many`);
      }

      // 4. interactive transaction (ai_agent onBehalfOf)
      await audit.as(
        agent,
        () =>
          prisma.$transaction(async (tx) => {
            await tx.invoice.update({
              where: { id: 1 },
              data: { status: "paid", passwordHash: "secret_hash_2" },
            });
            await sleep(15);
            await tx.lineItem.update({ where: { id: 20 }, data: { qty: 5 } });
          }),
        { context: { requestId: "req_engine_tx" } },
      );
      expected.push("invoice UPDATE 1 billing-agent", "line_item UPDATE 20 billing-agent");

      // 5. batch transaction
      await audit.as(user("u_batch"), () =>
        prisma.$transaction([
          prisma.invoice.update({ where: { id: 2 }, data: { total: 99 } }),
          prisma.lineItem.delete({ where: { id: 21 } }),
        ]),
      );
      expected.push("invoice UPDATE 2 u_batch", "line_item DELETE 21 u_batch");

      // 6. raw SQL ($executeRaw)
      await audit.as(
        user("u_raw"),
        () => prisma.$executeRaw`UPDATE invoice SET status = 'raw' WHERE id = 1`,
      );
      expected.push("invoice UPDATE 1 u_raw");

      // 7. upsert
      await audit.as(user("u_upsert"), () =>
        prisma.invoice.upsert({
          where: { id: 3 },
          create: { id: 3, status: "upserted" },
          update: { status: "upserted2" },
        }),
      );
      expected.push("invoice INSERT 3 u_upsert");

      // 8. updateMany
      await audit.as(user("u_updmany"), () =>
        prisma.invoice.updateMany({
          where: { id: { in: [1, 3] } },
          data: { total: 7 },
        }),
      );
      expected.push("invoice UPDATE 1 u_updmany", "invoice UPDATE 3 u_updmany");

      // 9. outside any actor scope
      await prisma.invoice.update({ where: { id: 3 }, data: { status: "no-actor" } });
      expected.push("invoice UPDATE 3 -");

      // 10. 40 concurrent requests (80 updates) through pool of 5
      await Promise.all(
        ids.map((i) =>
          audit.as(user(`c${i}`), async () => {
            await sleep((i * 11) % 29);
            await prisma.invoice.update({
              where: { id: 1000 + i },
              data: { status: `c${i}` },
            });
            await sleep((i * 13) % 31);
            await prisma.$transaction(async (tx) => {
              await sleep((i * 7) % 11);
              await tx.invoice.update({
                where: { id: 1000 + i },
                data: { total: i },
              });
            });
          }),
        ),
      );
      for (const i of ids) {
        expected.push(`invoice UPDATE ${1000 + i} c${i}`, `invoice UPDATE ${1000 + i} c${i}`);
      }

      // 11. delete with cascade (statement-level DELETE triggers with transition tables)
      await audit.as(user("u_delete"), () => prisma.invoice.delete({ where: { id: 2 } }));
      expected.push("invoice DELETE 2 u_delete", "line_item DELETE 20 u_delete");
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }

    const rows = await fetchAuditRows(adminClient, startId);
    assertExpectedMultiset(rows, expected);

    for (const row of rows) {
      expect(row.has_password_hash).toBe(false);
      if (row.actor_id === null) {
        expect(row.actor_source).toBeNull();
      } else {
        expect(row.actor_source).toBe("comment");
      }
    }

    const agentRows = rows.filter((r) => r.actor_id === "billing-agent");
    expect(agentRows).toHaveLength(2);
    for (const row of agentRows) {
      expect(row.actor_type).toBe("ai_agent");
      expect(row.on_behalf_of_id).toBe("u_42");
      expect(row.req_id).toBe("req_engine_tx");
    }
  });

  it("passes scenarios inside auditTransaction() storing actor_source = 'set_config'", async () => {
    const startId = await resetDataAndGetCursor(adminClient);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    const agent: Actor = {
      type: "ai_agent",
      id: "tx-agent",
      onBehalfOf: user("u_77"),
    };
    const expected: string[] = [];

    try {
      await audit.as(
        user("sc_create"),
        () =>
          auditTransaction(prisma, async (tx) => {
            await tx.invoice.create({
              data: { id: 10, status: "open", total: 20, passwordHash: "hidden" },
            });
          }),
        { context: { requestId: "req_sc_1" } },
      );
      expected.push("invoice INSERT 10 sc_create");

      await audit.as(user("sc_nested"), () =>
        auditTransaction(prisma, async (tx) => {
          await tx.invoice.create({
            data: {
              id: 11,
              status: "open",
              lineItems: {
                create: [
                  { id: 110, qty: 1 },
                  { id: 111, qty: 2 },
                ],
              },
            },
          });
        }),
      );
      expected.push(
        "invoice INSERT 11 sc_nested",
        "line_item INSERT 110 sc_nested",
        "line_item INSERT 111 sc_nested",
      );

      await audit.as(
        agent,
        () =>
          auditTransaction(prisma, async (tx) => {
            await tx.invoice.update({ where: { id: 10 }, data: { status: "paid" } });
            await tx.lineItem.update({ where: { id: 110 }, data: { qty: 9 } });
          }),
        { context: { requestId: "req_sc_agent" } },
      );
      expected.push("invoice UPDATE 10 tx-agent", "line_item UPDATE 110 tx-agent");

      await audit.as(user("sc_upsert"), () =>
        auditTransaction(prisma, async (tx) => {
          await tx.invoice.upsert({
            where: { id: 12 },
            create: { id: 12, status: "upserted" },
            update: { status: "updated" },
          });
        }),
      );
      expected.push("invoice INSERT 12 sc_upsert");

      await audit.as(user("sc_delete"), () =>
        auditTransaction(prisma, async (tx) => {
          await tx.invoice.delete({ where: { id: 11 } });
        }),
      );
      expected.push(
        "invoice DELETE 11 sc_delete",
        "line_item DELETE 110 sc_delete",
        "line_item DELETE 111 sc_delete",
      );
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }

    const rows = await fetchAuditRows(adminClient, startId);
    assertExpectedMultiset(rows, expected);
    for (const row of rows) {
      expect(row.actor_source).toBe("set_config");
      expect(row.has_password_hash).toBe(false);
    }

    const agentRows = rows.filter((r) => r.actor_id === "tx-agent");
    expect(agentRows).toHaveLength(2);
    for (const row of agentRows) {
      expect(row.actor_type).toBe("ai_agent");
      expect(row.on_behalf_of_id).toBe("u_77");
      expect(row.req_id).toBe("req_sc_agent");
    }
  });

  it("40 concurrent requests with distinct actors through PgBouncer (server pool 3, client pool 5) produce zero wrong actors", async () => {
    const startId = await resetDataAndGetCursor(adminClient);
    const pgbUrl = pgbouncer.urlFor(db.database, "app");
    const pool = new pg.Pool({ connectionString: pgbUrl, max: 5 });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter, comments: [auditstream()] });

    const ids = Array.from({ length: 40 }, (_, i) => i);

    try {
      await prisma.invoice.createMany({
        data: ids.map((i) => ({ id: 3000 + i, status: "seed" })),
      });

      await Promise.all(
        ids.map((i) =>
          audit.as(user(`pgb_${i}`), async () => {
            await sleep((i * 7) % 19);
            await prisma.invoice.update({
              where: { id: 3000 + i },
              data: { status: `pgb_${i}` },
            });
          }),
        ),
      );
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }

    const rows = await fetchAuditRows(adminClient, startId);
    const updates = rows.filter((r) => r.op === "UPDATE");
    expect(updates).toHaveLength(40);

    for (const row of updates) {
      const idx = Number(row.pk) - 3000;
      expect(row.actor_source).toBe("comment");
      expect(row.actor_id).toBe(`pgb_${idx}`);
    }
  });

  it("leak test through PgBouncer (server pool 3): 200 auditTransaction writes interleaved with 200 actor-less writes have zero leaks", async () => {
    const startId = await resetDataAndGetCursor(adminClient);
    const pgbUrl = pgbouncer.urlFor(db.database, "app");
    const pool = new pg.Pool({ connectionString: pgbUrl, max: 6 });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    const totalWrites = 400;
    const ids = Array.from({ length: totalWrites }, (_, i) => 4000 + i);

    try {
      await prisma.invoice.createMany({
        data: ids.map((id) => ({ id, status: "seed" })),
      });

      // Run 200 auditTransaction (even indices) interleaved with 200 actor-less writes (odd indices)
      // through 6 client connections multiplexed over 3 PgBouncer server connections.
      await Promise.all(
        ids.map((id, idx) => {
          if (idx % 2 === 0) {
            return audit.as(user(`leak_tx_${id}`), async () => {
              await auditTransaction(prisma, async (tx) => {
                await tx.invoice.update({
                  where: { id },
                  data: { status: `tx_${id}` },
                });
              });
            });
          }
          return prisma.invoice.update({
            where: { id },
            data: { status: `plain_${id}` },
          });
        }),
      );
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }

    const rows = await fetchAuditRows(adminClient, startId);
    const updates = rows.filter((r) => r.op === "UPDATE");
    expect(updates).toHaveLength(totalWrites);

    let setConfigCount = 0;
    let plainCount = 0;

    for (const row of updates) {
      const id = Number(row.pk);
      const idx = id - 4000;
      if (idx % 2 === 0) {
        expect(row.actor_source).toBe("set_config");
        expect(row.actor_id).toBe(`leak_tx_${id}`);
        setConfigCount += 1;
      } else {
        expect(row.actor_id).toBeNull();
        expect(row.actor_source).toBeNull();
        plainCount += 1;
      }
    }

    expect(setConfigCount).toBe(200);
    expect(plainCount).toBe(200);
  });
});
