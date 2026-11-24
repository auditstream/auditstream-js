import { type Actor, audit, encodeScope, type NestedActor } from "@auditstream/node";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import { PrismaNeon, PrismaNeonHttp } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditstream, type SqlCommenterPlugin } from "../../src/index.js";

interface InvoiceDelegate {
  create(args: {
    data: {
      id: number;
      status?: string;
      total?: number;
      lineItems?: { create: Array<{ id: number; qty?: number }> };
    };
  }): Promise<unknown>;
  createMany(args: {
    data: Array<{ id: number; status?: string; total?: number }>;
  }): Promise<unknown>;
  update(args: {
    where: { id: number };
    data: { status?: string; total?: number };
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

interface PrismaTransactionClient {
  readonly invoice: InvoiceDelegate;
  readonly lineItem: LineItemDelegate;
}

interface GeneratedPrismaClient extends PrismaTransactionClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $transaction<T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T>;
  $transaction<T extends readonly Promise<unknown>[]>(operations: [...T]): Promise<unknown[]>;
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

function user(id: string): NestedActor {
  return { type: "user", id };
}

interface AuditRow {
  table_name: string;
  op: string;
  pk: string;
  actor_id: string | null;
  actor_type: string | null;
  on_behalf_of_id: string | null;
  actor_source: string | null;
}

async function resetAuditState(adminClient: pg.Client): Promise<string> {
  await adminClient.query("DELETE FROM line_item; DELETE FROM invoice;");
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
            actor_source
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

interface PoolQueryRecord {
  readonly text: string;
  readonly name: string | undefined;
}

function spyOnPoolQueries(pool: pg.Pool): PoolQueryRecord[] {
  const recorded: PoolQueryRecord[] = [];

  const captureArg = (firstArg: unknown): void => {
    if (typeof firstArg === "string") {
      recorded.push({ text: firstArg, name: undefined });
      return;
    }
    if (firstArg && typeof firstArg === "object" && "text" in firstArg) {
      const cfg = firstArg as { text?: unknown; name?: unknown };
      if (typeof cfg.text === "string") {
        recorded.push({
          text: cfg.text,
          name: typeof cfg.name === "string" && cfg.name.length > 0 ? cfg.name : undefined,
        });
      }
    }
  };

  const originalPoolQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    captureArg(args[0]);
    return originalPoolQuery(...args);
  };

  pool.on("connect", (client) => {
    const originalClientQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      captureArg(args[0]);
      return originalClientQuery(...args);
    };
  });

  return recorded;
}

async function runKitScenarios(
  prisma: GeneratedPrismaClient,
  adminClient: pg.Client,
  options: { readonly supportsInteractiveTx: boolean },
): Promise<void> {
  const startId = await resetAuditState(adminClient);

  // Probe: SELECT current_query() inside a scope ends with the exact auditstream tag.
  const probeActor = user("probe");
  const probeRows = await audit.as(probeActor, () =>
    prisma.$queryRawUnsafe<Array<{ q: string }>>("SELECT current_query() AS q"),
  );
  const expectedSuffix = `/*auditstream='${encodeScope({ actor: probeActor })}'*/`;
  expect(probeRows[0]?.q.trimEnd().endsWith(expectedSuffix)).toBe(true);

  const agent: Actor = {
    type: "ai_agent",
    id: "billing-agent",
    onBehalfOf: user("u_42"),
  };
  const ids = Array.from({ length: 40 }, (_, i) => i);
  const expected: string[] = [];

  // 1. create
  await audit.as(user("u_create"), () =>
    prisma.invoice.create({ data: { id: 1, status: "open", total: 10 } }),
  );
  expected.push("invoice INSERT 1 u_create");

  // 2. nested create (not supported over stateless Neon HTTP without interactive tx? Works over WS and PG)
  if (options.supportsInteractiveTx) {
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
  }

  // 3. createMany (40 rows)
  await audit.as(user("u_many"), () =>
    prisma.invoice.createMany({
      data: ids.map((i) => ({ id: 1000 + i, status: "new" })),
    }),
  );
  for (const i of ids) {
    expected.push(`invoice INSERT ${1000 + i} u_many`);
  }

  // 4. interactive transaction (with ai_agent onBehalfOf)
  if (options.supportsInteractiveTx) {
    await audit.as(agent, () =>
      prisma.$transaction(async (tx) => {
        await tx.invoice.update({ where: { id: 1 }, data: { status: "paid" } });
        await sleep(20);
        await tx.lineItem.update({ where: { id: 20 }, data: { qty: 5 } });
      }),
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
  }

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

  // 10. 40 concurrent requests (80 updates total, interleaved on pool of 5)
  await Promise.all(
    ids.map((i) =>
      audit.as(user(`c${i}`), async () => {
        await sleep((i * 11) % 29);
        await prisma.invoice.update({
          where: { id: 1000 + i },
          data: { status: `c${i}` },
        });
        await sleep((i * 13) % 31);
        if (!options.supportsInteractiveTx) {
          await prisma.invoice.update({
            where: { id: 1000 + i },
            data: { total: i },
          });
        } else {
          await prisma.$transaction(async (tx) => {
            await sleep((i * 7) % 11);
            await tx.invoice.update({
              where: { id: 1000 + i },
              data: { total: i },
            });
          });
        }
      }),
    ),
  );
  for (const i of ids) {
    expected.push(`invoice UPDATE ${1000 + i} c${i}`, `invoice UPDATE ${1000 + i} c${i}`);
  }

  // 11. delete with cascade
  if (options.supportsInteractiveTx) {
    await audit.as(user("u_delete"), () => prisma.invoice.delete({ where: { id: 2 } }));
    expected.push("invoice DELETE 2 u_delete", "line_item DELETE 20 u_delete");
  }

  const rows = await fetchAuditRows(adminClient, startId);
  assertExpectedMultiset(rows, expected);

  // Verify every scoped row resolved via `comment`, unscoped row had `null`, and ai_agent preserved onBehalfOf.
  for (const row of rows) {
    if (row.actor_id === null) {
      expect(row.actor_source).toBeNull();
    } else {
      expect(row.actor_source).toBe("comment");
    }
  }

  if (options.supportsInteractiveTx) {
    const agentRows = rows.filter((r) => r.actor_id === "billing-agent");
    expect(agentRows).toHaveLength(2);
    for (const row of agentRows) {
      expect(row.actor_type).toBe("ai_agent");
      expect(row.on_behalf_of_id).toBe("u_42");
    }
  }
}

describe("@auditstream/prisma + PrismaPg integration", () => {
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

  it("ports every kit scenario on PrismaPg (pool max 5) with zero wrong actors and no named prepared statements", async () => {
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const observedQueries = spyOnPoolQueries(pool);
    const adapter = new PrismaPg(pool);
    const prisma = new PrismaClient({
      adapter,
      comments: [auditstream()],
    });

    try {
      await runKitScenarios(prisma, adminClient, { supportsInteractiveTx: true });

      // Pool spy assertion: tagged statements were sent, and ZERO carried a prepared statement `name`.
      const taggedQueries = observedQueries.filter((q) => q.text.includes("auditstream='"));
      expect(taggedQueries.length).toBeGreaterThan(0);
      const namedTaggedQueries = taggedQueries.filter((q) => q.name !== undefined);
      expect(namedTaggedQueries).toEqual([]);

      // Also verify pg_prepared_statements has zero auditstream= entries on this pool.
      const prepRes = await pool.query<{ name: string; statement: string }>(
        "SELECT name, statement FROM pg_prepared_statements",
      );
      const leaked = prepRes.rows.filter((r) => r.statement.includes("auditstream="));
      expect(leaked).toEqual([]);
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  it("resolves actors cleanly alongside traceContext() and queryTags() sqlcommenter plugins", async () => {
    const startId = await resetAuditState(adminClient);
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
    const adapter = new PrismaPg(pool);

    // Matches Prisma's @prisma/sqlcommenter-trace-context and @prisma/sqlcommenter-query-tags output.
    const traceContextPlugin: SqlCommenterPlugin = () => ({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    const queryTagsPlugin: SqlCommenterPlugin = () => ({
      route: "/api/invoices",
      service: "billing",
    });

    const prisma = new PrismaClient({
      adapter,
      comments: [traceContextPlugin, queryTagsPlugin, auditstream()],
    });

    try {
      const actor = user("u_coexist");
      const encoded = encodeScope({ actor });

      const probeRows = await audit.as(actor, () =>
        prisma.$queryRawUnsafe<Array<{ q: string }>>("SELECT current_query() AS q"),
      );
      const queryText = probeRows[0]?.q ?? "";
      // Prisma merges all plugin keys into one trailing comment sorted alphabetically:
      // auditstream= comes first, followed by route=, service=, traceparent=.
      expect(queryText).toContain(
        `/*auditstream='${encoded}',route='%2Fapi%2Finvoices',service='billing',traceparent='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'*/`,
      );

      await audit.as(actor, () =>
        prisma.invoice.create({ data: { id: 777, status: "coexist", total: 42 } }),
      );

      const rows = await fetchAuditRows(adminClient, startId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        table_name: "invoice",
        op: "INSERT",
        pk: "777",
        actor_id: "u_coexist",
        actor_type: "user",
        actor_source: "comment",
      });
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });
});

const neonTestUrl = process.env.NEON_TEST_URL;
const neonAdminUrl = process.env.NEON_ADMIN_URL ?? neonTestUrl;

if (!neonTestUrl) {
  console.info(
    "Skipping PrismaNeon and PrismaNeonHttp integration cells: NEON_TEST_URL is not set.",
  );
}

describe.skipIf(!neonTestUrl)("@auditstream/prisma + Neon adapters (NEON_TEST_URL)", () => {
  let PrismaClient: PrismaClientCtor;
  let adminClient: pg.Client;

  beforeAll(async () => {
    PrismaClient = await loadGeneratedPrismaClient();
    adminClient = new pg.Client({ connectionString: neonAdminUrl });
    await adminClient.connect();
  });

  afterAll(async () => {
    await adminClient?.end();
  });

  it("runs all kit scenarios on PrismaNeon (WebSocket)", async () => {
    const adapter = new PrismaNeon({ connectionString: neonTestUrl });
    const prisma = new PrismaClient({
      adapter,
      comments: [auditstream()],
    });

    try {
      await runKitScenarios(prisma, adminClient, { supportsInteractiveTx: true });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("runs stateless kit scenarios on PrismaNeonHttp (HTTP)", async () => {
    const adapter = new PrismaNeonHttp(neonTestUrl as string, {});
    const prisma = new PrismaClient({
      adapter,
      comments: [auditstream()],
    });

    try {
      await runKitScenarios(prisma, adminClient, { supportsInteractiveTx: false });
    } finally {
      await prisma.$disconnect();
    }
  });
});
