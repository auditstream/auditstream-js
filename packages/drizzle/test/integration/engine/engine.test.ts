import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, setConfigValue } from "@auditstream/node";
import {
  createTestDatabase,
  type NeonProxyInstance,
  type PgBouncerInstance,
  startNeonProxy,
  startPgBouncer,
  stopTestCluster,
  type TestDatabase,
} from "@auditstream/test-utils";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { eq as eq045, sql as sql045 } from "drizzle-orm";
import { drizzle as drizzleNeon045 } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg045 } from "drizzle-orm/node-postgres";
import { migrate as migrate045 } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePostgresJs045 } from "drizzle-orm/postgres-js";
import { eq as eqV1, sql as sqlV1 } from "drizzle-orm-v1";
import { drizzle as drizzleNeonV1 } from "drizzle-orm-v1/neon-serverless";
import { drizzle as drizzlePgV1 } from "drizzle-orm-v1/node-postgres";
import { migrate as migrateV1 } from "drizzle-orm-v1/node-postgres/migrator";
import { drizzle as drizzlePostgresJsV1 } from "drizzle-orm-v1/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapPgPool } from "../../../src/pg.js";
import { wrapPostgresJs } from "../../../src/postgres-js.js";
import { invoice as invoiceV1, lineItem as lineItemV1 } from "../../fixtures/engine/v1/schema.js";
import {
  invoice as invoice045,
  lineItem as lineItem045,
} from "../../fixtures/engine/v045/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../../fixtures/engine");
const V045_MIGRATIONS = resolve(FIXTURES_DIR, "v045/migrations");
const V1_MIGRATIONS = resolve(FIXTURES_DIR, "v1/migrations");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type DrizzleVersion = "0.45" | "1.x";

interface AuditRow {
  table_name: string;
  op: string;
  pk: number;
  actor_id: string | null;
  actor_source: string | null;
  has_password_hash: boolean;
}

async function prepareMigratedDatabase(version: DrizzleVersion): Promise<TestDatabase> {
  const db = await createTestDatabase();

  // Strip prototype tables/schema without dropping cluster-wide roles (`app_user`, `auditstream_owner`).
  const admin = new pg.Client({ connectionString: db.adminUrl });
  await admin.connect();
  try {
    await admin.query("DROP SCHEMA IF EXISTS auditstream CASCADE;");
    await admin.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await admin.query("DROP TABLE IF EXISTS public.line_item, public.invoice CASCADE;");
  } finally {
    await admin.end();
  }

  const migratePool = new pg.Pool({ connectionString: db.adminUrl, max: 1 });
  try {
    if (version === "0.45") {
      await migrate045(drizzlePg045({ client: migratePool }), {
        migrationsFolder: V045_MIGRATIONS,
      });
    } else {
      await migrateV1(drizzlePgV1({ client: migratePool }), {
        migrationsFolder: V1_MIGRATIONS,
      });
    }
  } finally {
    await migratePool.end();
  }

  return db;
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
            (record_id->>'id')::int AS pk,
            actor->>'id' AS actor_id,
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
  const got = rows.map(
    (r) => `${r.table_name} ${r.op} ${r.pk} ${r.actor_id ?? "-"} ${r.actor_source ?? "-"}`,
  );
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
  for (const row of rows) {
    expect(row.has_password_hash).toBe(false);
  }
}

interface ScenarioOptions {
  readonly version: DrizzleVersion;
  readonly runPreparedStatement: boolean;
}

async function runKitScenarios045(
  // biome-ignore lint/suspicious/noExplicitAny: shared helper across Drizzle 0.45 node-postgres, postgres.js, and neon-serverless drivers
  orm: any,
  opts: ScenarioOptions,
): Promise<string[]> {
  const expected: string[] = [];

  // 1. Multi-row INSERT (statement-level trigger + excluded password_hash)
  await audit.as({ type: "user", id: "d_insert" }, async () => {
    await orm.insert(invoice045).values([
      { id: 1, status: "a", total: "100", passwordHash: "secret_1" },
      { id: 2, status: "b", total: "50", passwordHash: "secret_2" },
    ]);
    await orm.insert(lineItem045).values([{ id: 10, invoiceId: 2, qty: 3 }]);
  });
  expected.push(
    "invoice INSERT 1 d_insert comment",
    "invoice INSERT 2 d_insert comment",
    "line_item INSERT 10 d_insert comment",
  );

  // 2. Interactive transaction with nested savepoint + cascade delete
  await audit.as({ type: "user", id: "d_tx" }, () =>
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction callback type varies by driver
    orm.transaction(async (tx: any) => {
      await tx.update(invoice045).set({ status: "tx" }).where(eq045(invoice045.id, 1));
      await sleep(10);
      // biome-ignore lint/suspicious/noExplicitAny: nested savepoint transaction
      await tx.transaction(async (sp: any) => {
        await sp.delete(invoice045).where(eq045(invoice045.id, 2));
      });
    }),
  );
  expected.push(
    "invoice UPDATE 1 d_tx comment",
    "invoice DELETE 2 d_tx comment",
    "line_item DELETE 10 d_tx comment",
  );

  // 3. Prepared statement
  if (opts.runPreparedStatement) {
    const prepared = orm
      .update(invoice045)
      .set({ status: sql045`${sql045.placeholder("status")}` })
      .where(eq045(invoice045.id, 1))
      .prepare("upd_engine_045");
    await audit.as({ type: "user", id: "d_prepared" }, () => prepared.execute({ status: "prep" }));
    expected.push("invoice UPDATE 1 d_prepared comment");
  }

  // 4. Actor-less seed of 40 rows
  const ids = Array.from({ length: 40 }, (_, i) => i);
  await orm
    .insert(invoice045)
    .values(ids.map((i) => ({ id: 100 + i, status: "new", passwordHash: `seed_pw_${i}` })));
  for (const i of ids) {
    expected.push(`invoice INSERT ${100 + i} - -`);
  }

  // 5. 40 concurrent requests with distinct actors through pool of 5
  await Promise.all(
    ids.map((i) =>
      audit.as({ type: "user", id: `k${i}` }, async () => {
        await sleep((i * 7) % 19);
        await orm
          .update(invoice045)
          .set({ status: `k${i}` })
          .where(eq045(invoice045.id, 100 + i));
      }),
    ),
  );
  for (const i of ids) {
    expected.push(`invoice UPDATE ${100 + i} k${i} comment`);
  }

  return expected;
}

async function runKitScenariosV1(
  // biome-ignore lint/suspicious/noExplicitAny: shared helper across Drizzle 1.x node-postgres, postgres.js, and neon-serverless drivers
  orm: any,
  opts: ScenarioOptions,
): Promise<string[]> {
  const expected: string[] = [];

  await audit.as({ type: "user", id: "d_insert" }, async () => {
    await orm.insert(invoiceV1).values([
      { id: 1, status: "a", total: "100", passwordHash: "secret_1" },
      { id: 2, status: "b", total: "50", passwordHash: "secret_2" },
    ]);
    await orm.insert(lineItemV1).values([{ id: 10, invoiceId: 2, qty: 3 }]);
  });
  expected.push(
    "invoice INSERT 1 d_insert comment",
    "invoice INSERT 2 d_insert comment",
    "line_item INSERT 10 d_insert comment",
  );

  await audit.as({ type: "user", id: "d_tx" }, () =>
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction callback type varies by driver
    orm.transaction(async (tx: any) => {
      await tx.update(invoiceV1).set({ status: "tx" }).where(eqV1(invoiceV1.id, 1));
      await sleep(10);
      // biome-ignore lint/suspicious/noExplicitAny: nested savepoint transaction
      await tx.transaction(async (sp: any) => {
        await sp.delete(invoiceV1).where(eqV1(invoiceV1.id, 2));
      });
    }),
  );
  expected.push(
    "invoice UPDATE 1 d_tx comment",
    "invoice DELETE 2 d_tx comment",
    "line_item DELETE 10 d_tx comment",
  );

  if (opts.runPreparedStatement) {
    const prepared = orm
      .update(invoiceV1)
      .set({ status: sqlV1`${sqlV1.placeholder("status")}` })
      .where(eqV1(invoiceV1.id, 1))
      .prepare("upd_engine_v1");
    await audit.as({ type: "user", id: "d_prepared" }, () => prepared.execute({ status: "prep" }));
    expected.push("invoice UPDATE 1 d_prepared comment");
  }

  const ids = Array.from({ length: 40 }, (_, i) => i);
  await orm
    .insert(invoiceV1)
    .values(ids.map((i) => ({ id: 100 + i, status: "new", passwordHash: `seed_pw_${i}` })));
  for (const i of ids) {
    expected.push(`invoice INSERT ${100 + i} - -`);
  }

  await Promise.all(
    ids.map((i) =>
      audit.as({ type: "user", id: `k${i}` }, async () => {
        await sleep((i * 7) % 19);
        await orm
          .update(invoiceV1)
          .set({ status: `k${i}` })
          .where(eqV1(invoiceV1.id, 100 + i));
      }),
    ),
  );
  for (const i of ids) {
    expected.push(`invoice UPDATE ${100 + i} k${i} comment`);
  }

  return expected;
}

function runKitScenarios(
  // biome-ignore lint/suspicious/noExplicitAny: shared dispatcher
  orm: any,
  opts: ScenarioOptions,
): Promise<string[]> {
  return opts.version === "0.45" ? runKitScenarios045(orm, opts) : runKitScenariosV1(orm, opts);
}

interface QueryablePool {
  query(sql: string): Promise<{ rows: Array<{ name: string; statement: string }> }>;
}

async function waitForNeonWsReady(pool: NeonPool): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }
  throw lastError;
}

async function assertNoTaggedPreparedStatementsPg(pool: QueryablePool): Promise<void> {
  const res = await pool.query("SELECT name, statement FROM pg_prepared_statements");
  const leaked = res.rows.filter((r) => r.statement.includes("auditstream="));
  expect(leaked).toEqual([]);
}

async function assertNoTaggedPreparedStatementsPostgresJs(
  sqlClient: ReturnType<typeof postgres>,
): Promise<void> {
  const rows = await sqlClient.unsafe<Array<{ name: string; statement: string }>>(
    "SELECT name, statement FROM pg_prepared_statements",
  );
  const leaked = rows.filter((r) => r.statement.includes("auditstream="));
  expect(leaked).toEqual([]);
}

describe("@auditstream/drizzle on real engine-generated migrations (0.45 and 1.x)", () => {
  let db045: TestDatabase;
  let dbV1: TestDatabase;
  let admin045: pg.Client;
  let adminV1: pg.Client;
  let pgbouncer: PgBouncerInstance;

  beforeAll(async () => {
    db045 = await prepareMigratedDatabase("0.45");
    dbV1 = await prepareMigratedDatabase("1.x");

    admin045 = new pg.Client({ connectionString: db045.adminUrl });
    adminV1 = new pg.Client({ connectionString: dbV1.adminUrl });
    await Promise.all([admin045.connect(), adminV1.connect()]);

    pgbouncer = await startPgBouncer({
      poolMode: "transaction",
      defaultPoolSize: 3,
      maxPreparedStatements: 200,
    });
  });

  afterAll(async () => {
    await pgbouncer?.stop();
    await admin045?.end();
    await adminV1?.end();
    await db045?.drop();
    await dbV1?.drop();
    await stopTestCluster();
  });

  function envFor(version: DrizzleVersion): { db: TestDatabase; admin: pg.Client } {
    return version === "0.45" ? { db: db045, admin: admin045 } : { db: dbV1, admin: adminV1 };
  }

  for (const version of ["0.45", "1.x"] as const) {
    describe(`Drizzle ${version} layout`, () => {
      it(`installs 8 engine triggers cleanly via Drizzle ${version} migrator`, async () => {
        const { admin } = envFor(version);
        const trigRes = await admin.query<{ count: string }>(
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
      });

      it(`direct: wrapPgPool (${version}) passes kit scenarios, 40 concurrent writes, and zero leaked prepared statements`, async () => {
        const { db, admin } = envFor(version);
        const startId = await resetDataAndGetCursor(admin);
        const pool = wrapPgPool(new pg.Pool({ connectionString: db.appUrl, max: 5 }));
        const orm =
          version === "0.45" ? drizzlePg045({ client: pool }) : drizzlePgV1({ client: pool });

        try {
          const expected = await runKitScenarios(orm, { version, runPreparedStatement: true });
          const rows = await fetchAuditRows(admin, startId);
          assertExpectedMultiset(rows, expected);
          await assertNoTaggedPreparedStatementsPg(pool);
        } finally {
          await pool.end();
        }
      });

      for (const prepare of [true, false] as const) {
        it(`direct: wrapPostgresJs prepare=${String(prepare)} (${version}) passes kit scenarios, 40 concurrent writes, and zero leaked prepared statements`, async () => {
          const { db, admin } = envFor(version);
          const startId = await resetDataAndGetCursor(admin);
          const sqlClient = wrapPostgresJs(postgres(db.appUrl, { max: 5, prepare }));
          const orm =
            version === "0.45"
              ? drizzlePostgresJs045(sqlClient)
              : drizzlePostgresJsV1({ client: sqlClient });

          try {
            const expected = await runKitScenarios(orm, { version, runPreparedStatement: true });
            const rows = await fetchAuditRows(admin, startId);
            assertExpectedMultiset(rows, expected);
            await assertNoTaggedPreparedStatementsPostgresJs(sqlClient);
          } finally {
            await sqlClient.end();
          }
        });
      }

      it(`direct: Neon WebSocket Pool (${version}) passes kit scenarios, 40 concurrent writes, and zero leaked prepared statements`, async () => {
        const { db, admin } = envFor(version);
        const startId = await resetDataAndGetCursor(admin);
        let proxy: NeonProxyInstance | undefined;
        let pool: NeonPool | undefined;

        try {
          const activeProxy = await startNeonProxy({ database: db.database });
          proxy = activeProxy;
          neonConfig.wsProxy = () => activeProxy.wsProxy;
          neonConfig.useSecureWebSocket = false;
          neonConfig.pipelineTLS = false;
          neonConfig.pipelineConnect = false;

          pool = wrapPgPool(new NeonPool({ connectionString: proxy.urlFor(db.database), max: 5 }));
          // Suppress idle WebSocket disconnect 'error' events during proxy startup warmup and teardown.
          pool.on("error", () => {});
          await waitForNeonWsReady(pool);
          const orm =
            version === "0.45" ? drizzleNeon045({ client: pool }) : drizzleNeonV1({ client: pool });

          const expected = await runKitScenarios(orm, { version, runPreparedStatement: true });
          const rows = await fetchAuditRows(admin, startId);
          assertExpectedMultiset(rows, expected);
          await assertNoTaggedPreparedStatementsPg(pool);
        } finally {
          await pool?.end();
          await proxy?.stop();
        }
      });

      it(`PgBouncer (pool 3, clients 5): wrapPgPool (${version}) passes kit scenarios and 40 concurrent writes`, async () => {
        const { db, admin } = envFor(version);
        const startId = await resetDataAndGetCursor(admin);
        const pool = wrapPgPool(
          new pg.Pool({ connectionString: pgbouncer.urlFor(db.database, "app"), max: 5 }),
        );
        const orm =
          version === "0.45" ? drizzlePg045({ client: pool }) : drizzlePgV1({ client: pool });

        try {
          const expected = await runKitScenarios(orm, { version, runPreparedStatement: true });
          const rows = await fetchAuditRows(admin, startId);
          assertExpectedMultiset(rows, expected);
        } finally {
          await pool.end();
        }
      });

      for (const prepare of [true, false] as const) {
        it(`PgBouncer (pool 3, clients 5): wrapPostgresJs prepare=${String(prepare)} (${version}) passes kit scenarios and 40 concurrent writes`, async () => {
          const { db, admin } = envFor(version);
          const startId = await resetDataAndGetCursor(admin);
          const sqlClient = wrapPostgresJs(
            postgres(pgbouncer.urlFor(db.database, "app"), { max: 5, prepare }),
          );
          const orm =
            version === "0.45"
              ? drizzlePostgresJs045(sqlClient)
              : drizzlePostgresJsV1({ client: sqlClient });

          try {
            const expected = await runKitScenarios(orm, { version, runPreparedStatement: false });
            const rows = await fetchAuditRows(admin, startId);
            assertExpectedMultiset(rows, expected);
          } finally {
            await sqlClient.end();
          }
        });
      }
    });
  }

  it("PgBouncer leak test (server pool 3, clients 6): interleaved set_config transactions and actor-less statements never leak actors", async () => {
    const startId = await resetDataAndGetCursor(admin045);
    const pool = new pg.Pool({ connectionString: pgbouncer.urlFor(db045.database, "app"), max: 6 });
    const orm = drizzlePg045({ client: pool });

    const totalWrites = 200;
    const ids = Array.from({ length: totalWrites }, (_, i) => 5000 + i);

    try {
      await orm.insert(invoice045).values(ids.map((id) => ({ id, status: "seed" })));

      await Promise.all(
        ids.map((id, idx) => {
          if (idx % 2 === 0) {
            const actorJson = setConfigValue({ actor: { type: "user", id: `sc_${id}` } });
            return orm.transaction(async (tx) => {
              await tx.execute(
                sql045`SELECT pg_catalog.set_config('auditstream.actor', ${actorJson}, true)`,
              );
              await tx
                .update(invoice045)
                .set({ status: `tx_${id}` })
                .where(eq045(invoice045.id, id));
            });
          }
          return orm
            .update(invoice045)
            .set({ status: `plain_${id}` })
            .where(eq045(invoice045.id, id));
        }),
      );
    } finally {
      await pool.end();
    }

    const rows = (await fetchAuditRows(admin045, startId)).filter((r) => r.op === "UPDATE");
    expect(rows).toHaveLength(totalWrites);

    let setConfigCount = 0;
    let plainCount = 0;
    for (const row of rows) {
      const idx = row.pk - 5000;
      if (idx % 2 === 0) {
        expect(row.actor_source).toBe("set_config");
        expect(row.actor_id).toBe(`sc_${row.pk}`);
        setConfigCount += 1;
      } else {
        expect(row.actor_id).toBeNull();
        expect(row.actor_source).toBeNull();
        plainCount += 1;
      }
    }

    expect(setConfigCount).toBe(totalWrites / 2);
    expect(plainCount).toBe(totalWrites / 2);
  });
});
