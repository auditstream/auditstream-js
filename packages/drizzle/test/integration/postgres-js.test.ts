import { audit, tagSql } from "@auditstream/node";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import { eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq as eqV1 } from "drizzle-orm-v1";
import { integer as integerV1, pgTable as pgTableV1, text as textV1 } from "drizzle-orm-v1/pg-core";
import { drizzle as drizzleV1 } from "drizzle-orm-v1/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditComment } from "../../src/comment.js";
import { wrapPostgresJs } from "../../src/postgres-js.js";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const invoiceV1 = pgTableV1("invoice", {
  id: integerV1("id").primaryKey(),
  status: textV1("status"),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("wrapPostgresJs() + Drizzle 0.45 postgres.js integration", () => {
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

  for (const prepare of [true, false] as const) {
    it(`captures insert, transaction with savepoint, actor-less seed, and 40 concurrent writes (prepare=${String(prepare)})`, async () => {
      const startId = await resetAuditState();
      const sql = wrapPostgresJs(postgres(db.appUrl, { max: 5, prepare }));
      const orm = drizzle(sql);

      try {
        // 1. Insert with actor
        await audit.as({ type: "user", id: "pjs_insert" }, () =>
          orm.insert(invoice).values([
            { id: 1, status: "a" },
            { id: 2, status: "b" },
          ]),
        );

        // 2. Interactive transaction with nested savepoint
        await audit.as({ type: "user", id: "pjs_tx" }, () =>
          orm.transaction(async (tx) => {
            await tx.update(invoice).set({ status: "tx" }).where(eq(invoice.id, 1));
            await sleep(10);
            await tx.transaction(async (sp) => {
              await sp.delete(invoice).where(eq(invoice.id, 2));
            });
          }),
        );

        // 3. Actor-less seed of 40 rows
        const ids = Array.from({ length: 40 }, (_, i) => i);
        await orm.insert(invoice).values(ids.map((i) => ({ id: 100 + i, status: "new" })));

        // 4. 40 concurrent updates with distinct actors through pool of 5
        await Promise.all(
          ids.map((i) =>
            audit.as({ type: "user", id: `p${i}` }, async () => {
              await sleep((i * 7) % 19);
              await orm
                .update(invoice)
                .set({ status: `p${i}` })
                .where(eq(invoice.id, 100 + i));
            }),
          ),
        );
      } finally {
        await sql.end();
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

      // 2 inserts + 1 tx update + 1 savepoint delete + 40 seeds + 40 concurrent updates = 84
      expect(rows).toHaveLength(84);

      expect(rows.slice(0, 4)).toEqual([
        { op: "INSERT", pk: 1, actor_id: "pjs_insert", actor_source: "comment" },
        { op: "INSERT", pk: 2, actor_id: "pjs_insert", actor_source: "comment" },
        { op: "UPDATE", pk: 1, actor_id: "pjs_tx", actor_source: "comment" },
        { op: "DELETE", pk: 2, actor_id: "pjs_tx", actor_source: "comment" },
      ]);

      const seedRows = rows.slice(4, 44);
      for (const row of seedRows) {
        expect(row.op).toBe("INSERT");
        expect(row.actor_id).toBeNull();
        expect(row.actor_source).toBeNull();
      }

      const concurrentRows = rows.slice(44);
      expect(concurrentRows).toHaveLength(40);
      for (const row of concurrentRows) {
        expect(row.op).toBe("UPDATE");
        expect(row.actor_source).toBe("comment");
        expect(row.actor_id).toBe(`p${row.pk - 100}`);
      }
    });
  }

  it("leaves zero auditstream= entries in pg_prepared_statements with prepare=true and max=1 after 40 actors", async () => {
    await resetAuditState();
    const sql = wrapPostgresJs(postgres(db.appUrl, { max: 1, prepare: true }));
    const orm = drizzle(sql);

    try {
      await orm.insert(invoice).values({ id: 500, status: "init" });

      for (let i = 0; i < 40; i += 1) {
        await audit.as({ type: "user", id: `prep_${i}` }, () =>
          orm
            .update(invoice)
            .set({ status: `s_${i}` })
            .where(eq(invoice.id, 500)),
        );
      }

      const prepared = await sql.unsafe<Array<{ name: string; statement: string }>>(
        "SELECT name, statement FROM pg_prepared_statements",
      );
      const leaked = prepared.filter((row) => row.statement.includes("auditstream="));
      expect(leaked).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("interleaves 20 actor-less and 20 tagged updates through max=2 with zero actor leaks", async () => {
    const startId = await resetAuditState();
    const sql = wrapPostgresJs(postgres(db.appUrl, { max: 2, prepare: true }));
    const orm = drizzle(sql);

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
                .set({ status: `plain_${id}` })
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
      await sql.end();
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

  it("leaves zero auditstream= entries in pg_prepared_statements when Drizzle 1.x .comment(auditComment()) runs through wrapPostgresJs()", async () => {
    const startId = await resetAuditState();
    const sql = wrapPostgresJs(postgres(db.appUrl, { max: 1, prepare: true }));
    const ormV1 = drizzleV1({ client: sql });

    try {
      await ormV1.insert(invoiceV1).values({ id: 600, status: "init" });

      for (let i = 0; i < 40; i += 1) {
        await audit.as({ type: "user", id: `v1_prep_${i}` }, () =>
          ormV1
            .update(invoiceV1)
            .set({ status: `v1_${i}` })
            .where(eqV1(invoiceV1.id, 600))
            .comment(auditComment()),
        );
      }

      // Pre-tagged SQL executed outside any active scope also disables prepare.
      const preTaggedOutside = tagSql("UPDATE invoice SET status = $1 WHERE id = $2", {
        actor: { type: "service", id: "v1_pre_outside" },
      });
      await sql.unsafe(preTaggedOutside, ["outside", 600], { prepare: true });

      const prepared = await sql.unsafe<Array<{ name: string; statement: string }>>(
        "SELECT name, statement FROM pg_prepared_statements",
      );
      const leaked = prepared.filter((row) => row.statement.includes("auditstream="));
      expect(leaked).toEqual([]);
    } finally {
      await sql.end();
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

    expect(updates).toHaveLength(41);
    for (let i = 0; i < 40; i += 1) {
      expect(updates[i]).toEqual({ actor_id: `v1_prep_${i}`, actor_source: "comment" });
    }
    expect(updates[40]).toEqual({ actor_id: "v1_pre_outside", actor_source: "comment" });
  });

  it("tags writes on sql.reserve() connections and handles the 2-arg unsafe(query, options) overload with prepare: false", async () => {
    const startId = await resetAuditState();
    const sql = wrapPostgresJs(postgres(db.appUrl, { max: 1, prepare: true }));

    try {
      await sql.unsafe("INSERT INTO invoice (id, status) VALUES ($1, $2)", [700, "seed"]);

      // 2-argument unsafe(query, options) overload directly on root client (both default simple and simple: false).
      const unsafeTwoArg = sql.unsafe as unknown as (
        query: string,
        opts: { prepare?: boolean; simple?: boolean },
      ) => Promise<unknown>;
      await audit.as({ type: "user", id: "two_arg_root_1" }, () =>
        unsafeTwoArg("UPDATE invoice SET status = 'two_arg_1' WHERE id = 700", { prepare: true }),
      );
      await audit.as({ type: "user", id: "two_arg_root_2" }, () =>
        unsafeTwoArg("UPDATE invoice SET status = 'two_arg_2' WHERE id = 700", {
          prepare: true,
          simple: false,
        }),
      );

      // Reserved connection: tagged across distinct scopes, 2-arg overload, Drizzle, pre-tagged, and unscoped.
      const reserved = await sql.reserve();
      try {
        await audit.as({ type: "user", id: "reserved_1" }, () =>
          reserved.unsafe("UPDATE invoice SET status = $1 WHERE id = $2", ["res_1", 700], {
            prepare: true,
          }),
        );
        const reservedUnsafeTwoArg = reserved.unsafe as unknown as (
          query: string,
          opts: { prepare?: boolean; simple?: boolean },
        ) => Promise<unknown>;
        await audit.as({ type: "user", id: "reserved_2" }, () =>
          reservedUnsafeTwoArg("UPDATE invoice SET status = 'res_2' WHERE id = 700", {
            prepare: true,
            simple: false,
          }),
        );

        // Pre-tagged write outside any scope on reserved connection still disables prepare.
        const preTaggedReserved = tagSql("UPDATE invoice SET status = $1 WHERE id = $2", {
          actor: { type: "service", id: "reserved_pre" },
        });
        await reserved.unsafe(preTaggedReserved, ["res_pre", 700], { prepare: true });

        // Tagged template on reserved connection passes through cleanly.
        const ping = await reserved`SELECT 1 AS ok`;
        expect(ping[0]?.ok).toBe(1);

        // Unscoped write on reserved connection leaves actor NULL.
        await reserved.unsafe("UPDATE invoice SET status = $1 WHERE id = $2", ["res_none", 700]);
      } finally {
        reserved.release();
      }

      const prepared = await sql.unsafe<Array<{ name: string; statement: string }>>(
        "SELECT name, statement FROM pg_prepared_statements",
      );
      const leaked = prepared.filter((row) => row.statement.includes("auditstream="));
      expect(leaked).toEqual([]);
    } finally {
      await sql.end();
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

    expect(updates).toEqual([
      { actor_id: "two_arg_root_1", actor_source: "comment" },
      { actor_id: "two_arg_root_2", actor_source: "comment" },
      { actor_id: "reserved_1", actor_source: "comment" },
      { actor_id: "reserved_2", actor_source: "comment" },
      { actor_id: "reserved_pre", actor_source: "comment" },
      { actor_id: null, actor_source: null },
    ]);
  });
});
