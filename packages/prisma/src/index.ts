import { audit, encodeScope } from "@auditstream/node";

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
 * Outside an active `audit.as()` scope, the plugin returns an empty object `{}` so no
 * `auditstream` key is emitted.
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
