import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  type PgBouncerInstance,
  startPgBouncer,
  stopTestCluster,
  type TestDatabase,
} from "../src/index.js";

function encodeComment(actor: { type: string; id: string }): string {
  const b64 = Buffer.from(JSON.stringify(actor)).toString("base64url");
  return `/*auditstream='${b64}'*/`;
}

describe("test-utils Postgres and PgBouncer harness", () => {
  let db: TestDatabase | undefined;
  let bouncer: PgBouncerInstance | undefined;

  afterAll(async () => {
    await bouncer?.stop();
    await db?.drop();
    await stopTestCluster();
  });

  it("captures tagged writes directly and through transaction-mode PgBouncer", async () => {
    db = await createTestDatabase();
    bouncer = await startPgBouncer();

    const directActor = { type: "user", id: "usr_direct" };
    const pooledActor = { type: "user", id: "usr_pooled" };

    const directClient = new pg.Client({ connectionString: db.appUrl });
    await directClient.connect();
    try {
      await directClient.query(
        `INSERT INTO invoice (id, status, total, password_hash) VALUES ($1, $2, $3, $4) ${encodeComment(directActor)}`,
        [1, "draft", "10.00", "secret_1"],
      );
    } finally {
      await directClient.end();
    }

    const pooledClient = new pg.Client({ connectionString: bouncer.urlFor(db.database, "app") });
    await pooledClient.connect();
    try {
      await pooledClient.query(
        `INSERT INTO invoice (id, status, total, password_hash) VALUES ($1, $2, $3, $4) ${encodeComment(pooledActor)}`,
        [2, "paid", "25.50", "secret_2"],
      );
    } finally {
      await pooledClient.end();
    }

    const adminClient = new pg.Client({ connectionString: db.adminUrl });
    await adminClient.connect();
    try {
      const result = await adminClient.query<{
        table_name: string;
        op: string;
        record_id: { id: number };
        after: Record<string, unknown>;
        actor: { type: string; id: string } | null;
        actor_source: string | null;
      }>(
        "SELECT table_name, op, record_id, after, actor, actor_source FROM auditstream.changes ORDER BY id",
      );

      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        table_name: "invoice",
        op: "INSERT",
        record_id: { id: 1 },
        actor: directActor,
        actor_source: "comment",
      });
      expect(result.rows[0]?.after).not.toHaveProperty("password_hash");

      expect(result.rows[1]).toMatchObject({
        table_name: "invoice",
        op: "INSERT",
        record_id: { id: 2 },
        actor: pooledActor,
        actor_source: "comment",
      });
      expect(result.rows[1]?.after).not.toHaveProperty("password_hash");
    } finally {
      await adminClient.end();
    }
  });
});
