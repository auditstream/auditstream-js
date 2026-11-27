---
"@auditstream/drizzle": patch
---

Prevent server-side prepared-statement cache leaks on pre-tagged queries (such as Drizzle 1.x `.comment(auditComment())`) by enforcing `prepare: false` in `wrapPostgresJs()` and dropping `name` in `wrapPgPool()` whenever `isTagged(query)` is true. Proxy `sql.reserve()` and support the 2-argument `sql.unsafe(query, options)` overload in `wrapPostgresJs()`, and document `postgres(url, { prepare: false })` for standalone `postgres.js` users of `auditComment()`.
