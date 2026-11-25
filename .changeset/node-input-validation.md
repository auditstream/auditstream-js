---
"@auditstream/node": patch
---

Reject NUL and unpaired UTF-16 surrogates in actor and context payloads (including `decodeScope()` for PostgreSQL parity), `audit.log()` events (`INVALID_EVENT`), and `audit.query()` / `audit.history()` text filters and record IDs (`INVALID_QUERY`) before executing SQL. Also reject malformed pagination cursors and out-of-range `since`/`until` timestamp bounds (`24:00:00`, timezone offsets beyond `±15:59`, and `Date` years outside `0001`–`9999`) with `INVALID_QUERY`.
