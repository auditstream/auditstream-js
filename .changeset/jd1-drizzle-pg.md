---
"@auditstream/drizzle": minor
---

Add `wrapPgPool()` in `@auditstream/drizzle/pg` to tag SQL statements on `node-postgres` (`pg.Pool`) and Neon WebSocket (`@neondatabase/serverless` `Pool`) with the caller's active `audit.as()` actor without leaking actors across pooled callbacks or creating per-actor named prepared statements.
