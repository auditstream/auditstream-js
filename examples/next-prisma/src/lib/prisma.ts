import { auditstream } from "@auditstream/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../generated/prisma/client";

const globalForPool = globalThis as typeof globalThis & {
  __auditstreamExamplePool?: pg.Pool;
};

// Keep the PrismaClient instance module-scoped while sharing the 5-connection pg.Pool on
// globalThis. In Next.js 16 Turbopack builds, Route Handlers and Server Actions can run in
// separate server chunks; keeping PrismaClient module-scoped ensures its `auditstream()`
// SQL comments plugin reads the same chunk's AsyncLocalStorage store as `withAudit`/`auditAction`.
let modulePrisma: PrismaClient | undefined;

/**
 * Returns a Prisma 7 client wired with `PrismaPg` over a shared `pg.Pool({ max: 5 })` and
 * the `@auditstream/prisma` SQL comments plugin.
 *
 * Never configure `statementNameGenerator` on `PrismaPg` alongside SQL comments.
 */
export function getPrisma(): PrismaClient {
  if (modulePrisma) {
    return modulePrisma;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = globalForPool.__auditstreamExamplePool ?? new pg.Pool({ connectionString, max: 5 });
  globalForPool.__auditstreamExamplePool = pool;

  const adapter = new PrismaPg(pool);
  modulePrisma = new PrismaClient({
    adapter,
    comments: [auditstream()],
  });
  return modulePrisma;
}
