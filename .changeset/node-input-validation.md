---
"@auditstream/node": patch
---

Reject NUL and unpaired surrogates in actor and context payloads. Return INVALID_QUERY before executing SQL when a pagination cursor contains an invalid timestamp or an ID outside the PostgreSQL bigint range.
