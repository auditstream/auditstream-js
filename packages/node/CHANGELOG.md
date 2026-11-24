# @auditstream/node

## 0.2.0

### Minor Changes

- 6b96a3c: Add `audit.query()` with validated filters (`table`, `schemaName`, `recordId`, `actor`, `tenant`, `source`, `op`, `opPrefix` via `pg_catalog.starts_with`, `since`, `until`), `app` event support, bounding-filter guardrails, and partition-pruning microsecond keyset pagination while keeping `audit.history()` backwards-compatible.
- 8c8e630: Add `audit.log(exec, event)` to record application-level audit events through `auditstream.log_event($1::text, $2::jsonb, $3::jsonb)` with Specification 0.1.0 validation and `AsyncLocalStorage` actor context propagation.
- 639b175: Add typed audit history helpers (`HistoryEntry`, `ExportRecord`, `parseExportRecord()` with arbitrary-precision `numeric` preservation, and `audit.history()` parameterized record lookup).

### Patch Changes

- 699521c: Align `decodeScope()`, `parseExportRecord()`, and `audit.history()` actor/context validation with the hardened Auditstream Specification 0.1.0 rules (closed 5-value `actor.type` enum, non-empty `tenant`, depth-1 `onBehalfOf`, and `context` object/known-field validation while preserving unknown keys) and sync conformance fixtures.
- a453cf6: Preserve full PostgreSQL microsecond precision for `occurred_at` in `audit.history()` using `pg_catalog.to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and harden `@auditstream/node` middleware README examples against header spoofing.
- 4b4cc7a: Pass an explicit locale-independent comparator when sorting extra actor and context keys during canonical JSON serialization.
- cebe2a6: Share the internal `AsyncLocalStorage` store via `globalThis[Symbol.for("auditstream.node.scopeStorage.v1")]` so separate server chunks (such as Next.js 16 Turbopack Route Handlers and Server Actions sharing a `globalThis` Prisma client) always observe the same active actor scope.
- 46cf7bb: Add `audit.as()`, `audit.current()`, and `AuditstreamError` with spec 0.1.0 validation and `AsyncLocalStorage` (`run()`-only) scope isolation.
- 6ee0af1: Add spec 0.1.0 actor transport codec (`encodeScope`, `decodeScope`, `tagSql`, `isTagged`, `setConfigValue`) and pin `spec-v0.1.0` conformance fixtures.
- efc4b30: Add Express (`/express`), Hono (`/hono`), and Next.js (`/next`) request actor scope helpers.
- f567c21: Cache canonical JSON and encoded tags for `audit.as()` scopes in a process-wide `WeakMap`, and add an O(1) trailing-character fast path to `isTagged()` and `decodeScope()`.
