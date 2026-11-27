---
"@auditstream/node": patch
"@auditstream/drizzle": patch
---

Export the ORM-agnostic PostgreSQL driver wrappers (`wrapPgPool`, `wrapPostgresJs`, and `wrapNeonHttp`) directly from `@auditstream/node/pg`, `@auditstream/node/postgres-js`, and `@auditstream/node/neon-http` with zero ORM peer dependencies, and re-export them from `@auditstream/drizzle/*` for 100% backwards compatibility. Fix the `@auditstream/node` README `audit.log()` example to tag outgoing SQL via `tagSql(sql)` so copy-pasted usage records the active actor instead of `NULL`.
