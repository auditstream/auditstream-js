import { wrapPgPool } from "@auditstream/drizzle/pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  readonly pool: pg.Pool;
  readonly db: AppDatabase;
  close(): Promise<void>;
}

/**
 * Creates a Drizzle 0.45 client backed by a wrapped `node-postgres` pool (`max: 5` by default).
 */
export function createDatabase(connectionString: string, max = 5): DatabaseHandle {
  const pool = wrapPgPool(new pg.Pool({ connectionString, max }));
  const db: AppDatabase = drizzle({ client: pool, schema });
  return {
    pool,
    db,
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
