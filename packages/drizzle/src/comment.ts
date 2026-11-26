import { AuditstreamError, audit, encodeScope } from "@auditstream/node";

/**
 * Primitive value accepted inside a Drizzle 1.x sqlcommenter object.
 *
 * Defined without importing `drizzle-orm` so `@auditstream/drizzle` public types
 * compile cleanly when only Drizzle 0.45 is installed.
 */
export type SqlCommenterValue = string | number | bigint | boolean | null | undefined;

/**
 * Plain sqlcommenter key-value map returned by {@link auditComment} and accepted
 * by Drizzle 1.x `.comment()` query builders and relational query `comment` options.
 */
export type SqlCommenterValues = Record<string, SqlCommenterValue>;

/**
 * Builds a Drizzle 1.x sqlcommenter object carrying the active Auditstream actor
 * under the `auditstream` key, merged with optional `extra` keys such as `traceparent`.
 *
 * - Inside an `audit.as()` scope, returns `{ ...extra, auditstream: encodeScope(scope) }`.
 * - Outside an `audit.as()` scope, returns `{ ...extra }` (or `{}` when `extra` is omitted),
 *   so Drizzle 1.x appends no comment when no keys are present.
 * - Throws an `AuditstreamError` if `extra` already defines an `auditstream` key.
 * - Reads the active actor when called, so build the query inside the `audit.as()` scope.
 *
 * ### Which Drizzle 1.x calls accept `.comment()`
 *
 * - `db.select(...).comment(auditComment())`
 * - `db.insert(...).values(...).comment(auditComment())`
 * - `db.update(...).set(...).where(...).comment(auditComment())`
 * - `db.delete(...).where(...).comment(auditComment())`
 * - Relational queries via `{ comment: auditComment() }`
 *
 * ### Prepared statements with standalone `postgres.js`
 *
 * When using `auditComment()` with `postgres.js` **without** `wrapPostgresJs()`, configure the
 * client with `postgres(url, { prepare: false })`. Otherwise `postgres.js` caches one permanent
 * server-side named prepared statement in `pg_prepared_statements` for every distinct actor or
 * `requestId` comment.
 *
 * ### Calls that still need a driver wrapper
 *
 * - `db.execute(sql)` and raw SQL helpers have no `.comment()` method.
 * - Transaction control statements (`BEGIN`, `COMMIT`, `SAVEPOINT`) have no `.comment()` method.
 * - Drizzle 0.45 has no `.comment()` API.
 *
 * For those paths, use a driver wrapper (`@auditstream/drizzle/pg`,
 * `@auditstream/drizzle/postgres-js`, or `@auditstream/drizzle/neon-http`); wrappers
 * inspect `isTagged()` to avoid double-tagging statements already tagged by `auditComment()`
 * while still disabling server-side named prepared statements (`prepare: false` / dropping `name`).
 */
export function auditComment(extra?: Readonly<SqlCommenterValues>): SqlCommenterValues {
  if (extra !== undefined && Object.hasOwn(extra, "auditstream")) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      'auditComment(): extra must not contain an "auditstream" key',
    );
  }

  const scope = audit.current();
  if (scope === undefined) {
    return extra === undefined ? {} : { ...extra };
  }

  const encoded = encodeScope(scope);
  return extra === undefined ? { auditstream: encoded } : { ...extra, auditstream: encoded };
}
