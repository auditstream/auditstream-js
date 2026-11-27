# @auditstream/drizzle

## 0.2.2

### Patch Changes

- 438baf3: Export the ORM-agnostic PostgreSQL driver wrappers (`wrapPgPool`, `wrapPostgresJs`, and `wrapNeonHttp`) directly from `@auditstream/node/pg`, `@auditstream/node/postgres-js`, and `@auditstream/node/neon-http` with zero ORM peer dependencies, and re-export them from `@auditstream/drizzle/*` for 100% backwards compatibility. Fix the `@auditstream/node` README `audit.log()` example to tag outgoing SQL via `tagSql(sql)` so copy-pasted usage records the active actor instead of `NULL`.
- 10ec746: Prevent server-side prepared-statement cache leaks on pre-tagged queries (such as Drizzle 1.x `.comment(auditComment())`) by enforcing `prepare: false` in `wrapPostgresJs()` and dropping `name` in `wrapPgPool()` whenever `isTagged(query)` is true. Proxy `sql.reserve()` and support the 2-argument `sql.unsafe(query, options)` overload in `wrapPostgresJs()`, and document `postgres(url, { prepare: false })` for standalone `postgres.js` users of `auditComment()`.
- 8c9fb0a: Add npm `keywords` and describe each package as part of the Auditstream database audit trail engine, so searches such as "hono audit trail" or "prisma audit log" can find them.

## 0.2.1

### Patch Changes

- 4893f97: Fix `@auditstream/drizzle` README imports (`drizzle-orm` instead of internal `drizzle-orm-v1`), polish all published package READMEs with idiomatic examples and verified badges, and add `homepage` metadata pointing to `https://auditstream.dev/docs/typescript/`.
- 0bee515: Update package `homepage` URLs to point directly to the `/docs/typescript/` documentation routes.

## 0.2.0

### Minor Changes

- 4b6a185: Add `wrapPgPool()` in `@auditstream/drizzle/pg` to tag SQL statements on `node-postgres` (`pg.Pool`) and Neon WebSocket (`@neondatabase/serverless` `Pool`) with the caller's active `audit.as()` actor without leaking actors across pooled callbacks or creating per-actor named prepared statements.
- 135d59f: Add `wrapNeonHttp()` in `@auditstream/drizzle/neon-http` to tag Neon HTTP queries, plain string calls, HTTP transactions, and Drizzle `db.batch()` queries with the active actor.
- ca78099: Add `wrapPostgresJs()` in `@auditstream/drizzle/postgres-js` to tag Drizzle `postgres.js` `unsafe()` statements across root, `begin()`, and nested `savepoint()` clients while forcing `prepare: false` on tagged calls.
- 215f04b: Add `auditComment()` in `@auditstream/drizzle` for Drizzle 1.x `.comment()` query builders and relational queries, merging optional extra sqlcommenter keys without importing `drizzle-orm` in public types.
