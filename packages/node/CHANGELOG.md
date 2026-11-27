# @auditstream/node

## 0.2.2

### Patch Changes

- 438baf3: Export the ORM-agnostic PostgreSQL driver wrappers (`wrapPgPool`, `wrapPostgresJs`, and `wrapNeonHttp`) directly from `@auditstream/node/pg`, `@auditstream/node/postgres-js`, and `@auditstream/node/neon-http` with zero ORM peer dependencies, and re-export them from `@auditstream/drizzle/*` for 100% backwards compatibility. Fix the `@auditstream/node` README `audit.log()` example to tag outgoing SQL via `tagSql(sql)` so copy-pasted usage records the active actor instead of `NULL`.
- b000660: Validate `occurred_at` calendar dates and clock ranges in `parseExportRecord()` using the shared proleptic Gregorian date validator.
- 892ad3b: Prevent prototype hijacking via `__proto__`, `constructor`, and `prototype` keys (and custom object prototypes) across `audit.as()`, `encodeScope()`, `setConfigValue()`, `tagSql()`, and `decodeScope()`. Harden `isTagged()`, `tagSql()`, and `decodeScope()` with a PostgreSQL-aware SQL lexer and strict sqlcommenter parser so trailing `--` line comments receive a newline before `/*auditstream='...'*/`, malformed or embedded `,auditstream='...'` comments never suppress tagging, and `decodeScope()` rejects NUL and unpaired UTF-16 surrogates even inside shadowed duplicate JSON keys.
- cca493d: Parameterize `@auditstream/node/hono` (`HonoAuditOptions<E extends Env = any>`, `auditstream<E extends Env = any>()`) and `@auditstream/node/express` (`ExpressAuditOptions<TRequest extends Request = Request, TLocals extends Record<string, any> = Record<string, unknown>>`, `auditstream<TRequest, TLocals>()`) so callers get strongly typed `Context<AppEnv>`, `AuthedRequest`, and `res.locals` inside `actor` and `context` resolvers without inline `as` assertions, while remaining 100% backwards compatible. Guard `@auditstream/node/express` against calling `next()` when a resolver already sent or ended `res`.
- a359bc3: Reject NUL and unpaired UTF-16 surrogates in actor and context payloads (including `decodeScope()` for PostgreSQL parity), `audit.log()` events (`INVALID_EVENT`), and `audit.query()` / `audit.history()` text filters and record IDs (`INVALID_QUERY`) before executing SQL. Also reject malformed pagination cursors and out-of-range `since`/`until` timestamp bounds (`24:00:00`, timezone offsets beyond `±15:59`, and `Date` years outside `0001`–`9999`) with `INVALID_QUERY`.
- 8c9fb0a: Add npm `keywords` and describe each package as part of the Auditstream database audit trail engine, so searches such as "hono audit trail" or "prisma audit log" can find them.
- e161cda: Table-qualify `ORDER BY changes.occurred_at DESC, changes.id DESC` in `audit.history()` and `audit.query()` so PostgreSQL orders by native `timestamptz`/`bigint` columns instead of the `to_char(...)` and `id::text` SELECT aliases, fixing index usage and keyset pagination across power-of-10 `id` ties.

## 0.2.1

### Patch Changes

- 4893f97: Fix `@auditstream/drizzle` README imports (`drizzle-orm` instead of internal `drizzle-orm-v1`), polish all published package READMEs with idiomatic examples and verified badges, and add `homepage` metadata pointing to `https://auditstream.dev/docs/typescript/`.
- 0bee515: Update package `homepage` URLs to point directly to the `/docs/typescript/` documentation routes.

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
