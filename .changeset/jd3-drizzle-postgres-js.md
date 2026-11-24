---
"@auditstream/drizzle": minor
---

Add `wrapPostgresJs()` in `@auditstream/drizzle/postgres-js` to tag Drizzle `postgres.js` `unsafe()` statements across root, `begin()`, and nested `savepoint()` clients while forcing `prepare: false` on tagged calls.
