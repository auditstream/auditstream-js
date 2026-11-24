---
"@auditstream/node": minor
---

Add `audit.query()` with validated filters (`table`, `schemaName`, `recordId`, `actor`, `tenant`, `source`, `op`, `opPrefix` via `pg_catalog.starts_with`, `since`, `until`), `app` event support, bounding-filter guardrails, and partition-pruning microsecond keyset pagination while keeping `audit.history()` backwards-compatible.
