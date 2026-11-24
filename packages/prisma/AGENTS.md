# `@auditstream/prisma` Agent Rules

Rules established by JC1 that bind JC2 and subsequent changes to `@auditstream/prisma`:

- Keep `SqlCommenterPlugin` declared as a local structural type with optional context — avoids a `@prisma/sqlcommenter` runtime/type dependency while staying assignable across `@prisma/client` 7.1.0–7.x and keeping `attw` clean.
- Return `{}` (omitting the `auditstream` key) when `audit.current()` is `undefined` — guarantees actor-less queries never emit an empty or stale `auditstream` tag.
- Never configure `PrismaPg`'s `statementNameGenerator` alongside SQL comments — named prepared statements with per-actor comments grow unboundedly in `node-postgres` and violate `spec/transport.md`.
- Always pass `audit.as()` callbacks that await Prisma queries inside the scope — Prisma queries are lazy thenables and lose `AsyncLocalStorage` context if awaited after `audit.as()` returns.
- Provide a `set_config` interactive-transaction fallback in JC2 for Prisma Accelerate — Accelerate hides SQL from comment plugins and does not document comment delivery to PostgreSQL.
- Keep generated Prisma clients (`test/integration/generated/`) gitignored and dynamically imported in integration tests — keeps generated code out of git and lets clean-checkout `tsc --noEmit` (including TypeScript 7) pass without pre-running `prisma generate`.
- Preserve compatibility with `@prisma/client >=7.1.0 <8` and never add the `prisma` CLI to `peerDependencies` — `7.1.0` is the first release with `comments`, and npm `latest` for `prisma` points to Prisma 8 RC.
- Do not assume `auditstream=` is the sole or final key in the trailing SQL comment — Prisma merges and alphabetically sorts keys across all installed plugins (`traceContext()`, `queryTags()`), placing `auditstream=` first.
