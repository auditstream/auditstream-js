---
"@auditstream/node": patch
---

Table-qualify `ORDER BY changes.occurred_at DESC, changes.id DESC` in `audit.history()` and `audit.query()` so PostgreSQL orders by native `timestamptz`/`bigint` columns instead of the `to_char(...)` and `id::text` SELECT aliases, fixing index usage and keyset pagination across power-of-10 `id` ties.
