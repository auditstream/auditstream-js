---
"@auditstream/node": patch
---

Align `decodeScope()`, `parseExportRecord()`, and `audit.history()` actor/context validation with the hardened Auditstream Specification 0.1.0 rules (closed 5-value `actor.type` enum, non-empty `tenant`, depth-1 `onBehalfOf`, and `context` object/known-field validation while preserving unknown keys) and sync conformance fixtures.
