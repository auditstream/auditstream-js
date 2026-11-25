---
"@auditstream/node": patch
---

Reject NUL and unpaired surrogates in actor and context payloads. `audit.query()` and `audit.history()` return `INVALID_QUERY` before executing SQL when a text filter or record ID contains them, or when a pagination cursor contains an invalid timestamp or an ID outside the PostgreSQL bigint range.
