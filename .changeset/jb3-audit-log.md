---
"@auditstream/node": minor
---

Add `audit.log(exec, event)` to record application-level audit events through `auditstream.log_event($1::text, $2::jsonb, $3::jsonb)` with Specification 0.1.0 validation and `AsyncLocalStorage` actor context propagation.
