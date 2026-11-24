---
"@auditstream/node": patch
---

Cache canonical JSON and encoded tags for `audit.as()` scopes in a process-wide `WeakMap`, and add an O(1) trailing-character fast path to `isTagged()` and `decodeScope()`.
