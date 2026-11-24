# @auditstream/drizzle

## 0.2.0

### Minor Changes

- 4b6a185: Add `wrapPgPool()` in `@auditstream/drizzle/pg` to tag SQL statements on `node-postgres` (`pg.Pool`) and Neon WebSocket (`@neondatabase/serverless` `Pool`) with the caller's active `audit.as()` actor without leaking actors across pooled callbacks or creating per-actor named prepared statements.
- 135d59f: Add `wrapNeonHttp()` in `@auditstream/drizzle/neon-http` to tag Neon HTTP queries, plain string calls, HTTP transactions, and Drizzle `db.batch()` queries with the active actor.
- ca78099: Add `wrapPostgresJs()` in `@auditstream/drizzle/postgres-js` to tag Drizzle `postgres.js` `unsafe()` statements across root, `begin()`, and nested `savepoint()` clients while forcing `prepare: false` on tagged calls.
- 215f04b: Add `auditComment()` in `@auditstream/drizzle` for Drizzle 1.x `.comment()` query builders and relational queries, merging optional extra sqlcommenter keys without importing `drizzle-orm` in public types.
