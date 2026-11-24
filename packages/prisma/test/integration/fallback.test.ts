import { type Actor, audit } from "@auditstream/node";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditstream,
  auditTransaction,
  type PrismaRawExecutor,
  type PrismaTransactionRunner,
  type SqlCommenterPlugin,
} from "../../src/index.js";

interface InvoiceDelegate {
  create(args: { data: { id: number; status?: string; total?: number } }): Promise<unknown>;
  createMany(args: {
    data: Array<{ id: number; status?: string; total?: number }>;
  }): Promise<unknown>;
  update(args: {
    where: { id: number };
    data: { status?: string; total?: number };
  }): Promise<{ id: number; status: string | null }>;
}

interface GeneratedTxClient extends PrismaRawExecutor {
  readonly invoice: InvoiceDelegate;
}

interface GeneratedPrismaClient
  extends GeneratedTxClient,
    PrismaTransactionRunner<GeneratedTxClient, { maxWait?: number; timeout?: number }> {
  $disconnect(): Promise<void>;
}

type PrismaClientCtor = new (options: {
  adapter: unknown;
  comments?: readonly SqlCommenterPlugin[];
}) => GeneratedPrismaClient;

async function loadGeneratedPrismaClient(): Promise<PrismaClientCtor> {
  // Dynamic path prevents `tsc --noEmit` from requiring `prisma generate` on a clean checkout.
  const clientPath = "./generated/prisma/client.ts";
  const mod = (await import(clientPath)) as { PrismaClient: PrismaClientCtor };
  return mod.PrismaClient;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface AuditRow {
  op: string;
  pk: number;
  actor_id: string | null;
  actor_type: string | null;
  on_behalf_of_id: string | null;
  req_id: string | null;
  actor_source: string | null;
}

async function resetAuditState(adminClient: pg.Client): Promise<string> {
  await adminClient.query("DELETE FROM line_item; DELETE FROM invoice;");
  const res = await adminClient.query<{ m: string }>(
    "SELECT coalesce(max(id), 0)::text AS m FROM auditstream.changes",
  );
  return res.rows[0]?.m ?? "0";
}

async function fetchInvoiceAuditRows(adminClient: pg.Client, startId: string): Promise<AuditRow[]> {
  const res = await adminClient.query<AuditRow>(
    `SELECT op,
            (record_id->>'id')::int AS pk,
            actor->>'id' AS actor_id,
            actor->>'type' AS actor_type,
            actor->'onBehalfOf'->>'id' AS on_behalf_of_id,
            coalesce(context->>'requestId', actor->'context'->>'requestId') AS req_id,
            actor_source
       FROM auditstream.changes
      WHERE id > $1 AND table_name = 'invoice'
      ORDER BY id ASC`,
    [startId],
  );
  return res.rows;
}

describe("@auditstream/prisma auditTransaction() set_config integration", () => {
  let db: TestDatabase;
  let adminClient: pg.Client;
  let PrismaClient: PrismaClientCtor;

  beforeAll(async () => {
    PrismaClient = await loadGeneratedPrismaClient();
    db = await createTestDatabase();
    adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
  });

  afterAll(async () => {
    await adminClient?.end();
    await db?.drop();
    await stopTestCluster();
  });

  it("stores actor_source = 'set_config' both WITH and WITHOUT the comments plugin, and NULL outside a scope", async () => {
    const startId = await resetAuditState(adminClient);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const adapter = new PrismaPg(pool);

    const prismaNoComments = new PrismaClient({ adapter });
    const prismaWithComments = new PrismaClient({ adapter, comments: [auditstream()] });

    try {
      await prismaNoComments.invoice.create({ data: { id: 1, status: "seed", total: 10 } });

      const agent: Actor = {
        type: "ai_agent",
        id: "accel-agent",
        onBehalfOf: { type: "user", id: "u_99" },
      };

      // 1. Without comments plugin installed -> actor_source must be 'set_config'.
      const r1 = await audit.as(
        agent,
        () =>
          auditTransaction(
            prismaNoComments,
            async (tx) => tx.invoice.update({ where: { id: 1 }, data: { status: "no-comments" } }),
            { timeout: 10_000 },
          ),
        { context: { requestId: "req_no_comments" } },
      );
      expect(r1.status).toBe("no-comments");

      // 2. With comments plugin ALSO installed -> set_config wins precedence over comment!
      const r2 = await audit.as(
        { type: "user", id: "u_both" },
        () =>
          auditTransaction(prismaWithComments, async (tx) =>
            tx.invoice.update({ where: { id: 1 }, data: { status: "with-comments" } }),
          ),
        { context: { requestId: "req_both" } },
      );
      expect(r2.status).toBe("with-comments");

      // 3. Outside any audit.as() scope -> auditTransaction runs without set_config -> actor NULL.
      const r3 = await auditTransaction(prismaNoComments, async (tx) =>
        tx.invoice.update({ where: { id: 1 }, data: { status: "unscoped-tx" } }),
      );
      expect(r3.status).toBe("unscoped-tx");
    } finally {
      await prismaWithComments.$disconnect();
      await prismaNoComments.$disconnect();
      await pool.end();
    }

    const rows = await fetchInvoiceAuditRows(adminClient, startId);
    expect(rows).toEqual([
      {
        op: "INSERT",
        pk: 1,
        actor_id: null,
        actor_type: null,
        on_behalf_of_id: null,
        req_id: null,
        actor_source: null,
      },
      {
        op: "UPDATE",
        pk: 1,
        actor_id: "accel-agent",
        actor_type: "ai_agent",
        on_behalf_of_id: "u_99",
        req_id: "req_no_comments",
        actor_source: "set_config",
      },
      {
        op: "UPDATE",
        pk: 1,
        actor_id: "u_both",
        actor_type: "user",
        on_behalf_of_id: null,
        req_id: "req_both",
        actor_source: "set_config",
      },
      {
        op: "UPDATE",
        pk: 1,
        actor_id: null,
        actor_type: null,
        on_behalf_of_id: null,
        req_id: null,
        actor_source: null,
      },
    ]);
  });

  it("leak test on pool of 1: plain write right after auditTransaction on the same connection stores actor NULL", async () => {
    const startId = await resetAuditState(adminClient);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 1 });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    try {
      await prisma.invoice.create({ data: { id: 50, status: "init" } });

      await audit.as({ type: "user", id: "u_tx_only" }, () =>
        auditTransaction(prisma, async (tx) =>
          tx.invoice.update({ where: { id: 50 }, data: { status: "in-tx" } }),
        ),
      );

      // Immediately reuse the sole connection in the pool for a plain unscoped write.
      await prisma.invoice.update({ where: { id: 50 }, data: { status: "after-tx" } });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }

    const rows = await fetchInvoiceAuditRows(adminClient, startId);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      op: "UPDATE",
      pk: 50,
      actor_id: "u_tx_only",
      actor_source: "set_config",
    });
    expect(rows[2]).toMatchObject({
      op: "UPDATE",
      pk: 50,
      actor_id: null,
      actor_source: null,
    });
  });

  it("40 concurrent requests with distinct actors using auditTransaction through a pool of 5 produce zero wrong actors", async () => {
    const startId = await resetAuditState(adminClient);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({ adapter });

    const ids = Array.from({ length: 40 }, (_, i) => i);

    try {
      await prisma.invoice.createMany({
        data: ids.map((i) => ({ id: 2000 + i, status: "seed" })),
      });

      await Promise.all(
        ids.map((i) =>
          audit.as({ type: "user", id: `sc_${i}` }, async () => {
            await sleep((i * 7) % 19);
            await auditTransaction(prisma, async (tx) => {
              await sleep((i * 5) % 13);
              await tx.invoice.update({
                where: { id: 2000 + i },
                data: { status: `sc_${i}` },
              });
            });
          }),
        ),
      );
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }

    const rows = await fetchInvoiceAuditRows(adminClient, startId);
    const updates = rows.filter((r) => r.op === "UPDATE");
    expect(updates).toHaveLength(40);

    for (const row of updates) {
      const idx = row.pk - 2000;
      expect(row.actor_source).toBe("set_config");
      expect(row.actor_id).toBe(`sc_${idx}`);
      expect(row.actor_type).toBe("user");
    }
  });
});
