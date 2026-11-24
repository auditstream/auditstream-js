import { audit, encodeScope } from "@auditstream/node";

export {
  auditTransaction,
  type PrismaRawExecutor,
  type PrismaTransactionRunner,
} from "./fallback.js";

/** Package identifier exported by `@auditstream/prisma`. */
export const PACKAGE_NAME: "@auditstream/prisma" = "@auditstream/prisma";

/**
 * Key-value map returned by a Prisma SQL comments plugin.
 * Keys with an `undefined` value are omitted by Prisma when building the trailing comment.
 */
export type SqlCommenterTags = {
  readonly [key: string]: string | undefined;
};

/**
 * Query metadata passed by Prisma to SQL comments plugins.
 *
 * Declared structurally so `@auditstream/prisma` carries no dependency on `@prisma/sqlcommenter`
 * and stays assignable across `@prisma/client` 7.1.0 through 7.x.
 */
export interface SqlCommenterContext {
  /** Metadata about the single or compacted Prisma query being executed. */
  readonly query?: unknown;
  /** Rendered SQL statement when available (omitted under Prisma Accelerate). */
  readonly sql?: string;
}

/**
 * Prisma 7 SQL comments plugin compatible with `new PrismaClient({ comments: [auditstream()] })`.
 */
export type SqlCommenterPlugin = (context?: SqlCommenterContext) => SqlCommenterTags;

/**
 * Creates a Prisma 7 SQL comments plugin that attaches the active `audit.as()` actor and
 * context as an `auditstream` sqlcommenter tag.
 *
 * - **Supported versions:** Requires `@prisma/client` 7.1.0 or newer within Prisma 7.x
 *   (`>=7.1.0 <8`). Prisma 6 is not supported.
 * - **Empty outside scope:** Outside an active `audit.as()` scope, the plugin returns `{}`
 *   so no `auditstream` key is emitted.
 * - **Prisma Accelerate limit:** Under Prisma Accelerate, SQL comments plugins do not receive
 *   rendered SQL and comment delivery to PostgreSQL is undocumented. Use
 *   {@link auditTransaction} (`set_config` fallback) for Accelerate workloads.
 * - **`statementNameGenerator` rule:** Never configure `PrismaPg`'s optional
 *   `statementNameGenerator` alongside SQL comments. Per-actor comments paired with named
 *   prepared statements grow `node-postgres`'s prepared-statement cache unboundedly and
 *   violate `spec/transport.md`.
 *
 * @example
 * ```ts
 * import { PrismaPg } from "@prisma/adapter-pg";
 * import { audit } from "@auditstream/node";
 * import { auditstream } from "@auditstream/prisma";
 * import { PrismaClient } from "./generated/prisma/client";
 *
 * const prisma = new PrismaClient({
 *   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
 *   comments: [auditstream()],
 * });
 *
 * await audit.as({ type: "user", id: "usr_1" }, () =>
 *   prisma.invoice.update({ where: { id: 1 }, data: { status: "paid" } }),
 * );
 * ```
 */
export function auditstream(): SqlCommenterPlugin {
  return (): SqlCommenterTags => {
    const scope = audit.current();
    if (!scope) {
      return {};
    }
    return { auditstream: encodeScope(scope) };
  };
}
