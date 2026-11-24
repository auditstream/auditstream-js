import { auditstream } from "@auditstream/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "../../generated/prisma/client";

const globalForPrisma = globalThis as typeof globalThis & {
  __auditstreamExamplePrisma?: PrismaClient;
  __auditstreamExamplePool?: pg.Pool;
};

/**
 * Returns a shared `globalThis` Prisma 7 client wired with `PrismaPg` (`max: 5`) and the
 * `@auditstream/prisma` SQL comments plugin.
 *
 * Because `@auditstream/node` stores its `AsyncLocalStorage` on a shared `Symbol.for` slot
 * on `globalThis`, Route Handlers (`withAudit`) and Server Actions (`auditAction`) share
 * the same active actor scope even when bundled into separate Next.js server chunks.
 *
 * Never configure `statementNameGenerator` on `PrismaPg` alongside SQL comments.
 */
export function getPrisma(): PrismaClient {
  if (globalForPrisma.__auditstreamExamplePrisma) {
    return globalForPrisma.__auditstreamExamplePrisma;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString, max: 5 });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({
    adapter,
    comments: [auditstream()],
  });

  globalForPrisma.__auditstreamExamplePool = pool;
  globalForPrisma.__auditstreamExamplePrisma = prisma;
  return prisma;
}
