---
"@auditstream/node": patch
---

Preserve full PostgreSQL microsecond precision for `occurred_at` in `audit.history()` using `pg_catalog.to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and harden `@auditstream/node` middleware README examples against header spoofing.
