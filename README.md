# auditstream-js

TypeScript adapters and query helpers for [Auditstream](https://github.com/auditstream/auditstream), an open-source PostgreSQL audit trail engine.

Application code never writes audit rows directly. These packages propagate the active actor through `AsyncLocalStorage` and attach it to outgoing SQL queries so PostgreSQL capture triggers record who acted — including delegated AI agents (`onBehalfOf`).

**Status:** v0.1 (pre-1.0), targeting [Auditstream Specification 0.1.1 (`spec-v0.1.1`)](https://github.com/auditstream/auditstream/tree/spec-v0.1.1/spec).

## Packages

All three packages are ESM-only, zero-dependency on the runtime path, and released together as a single Changesets `fixed` group:

| Package | Purpose | Docs |
| --- | --- | --- |
| `@auditstream/node` | `AsyncLocalStorage` actor scope (`audit.as()`, `audit.current()`), application events (`audit.log()`), record lookups (`audit.history()`), keyset-paginated queries (`audit.query()`), export record parser (`parseExportRecord()`), and Express, Hono, and Next.js integrations | [README](packages/node/README.md) |
| `@auditstream/prisma` | Prisma 7 SQL comments plugin (`auditstream()`) and transaction-local `set_config` fallback (`auditTransaction()`) for Prisma Accelerate or proxies that strip comments | [README](packages/prisma/README.md) |
| `@auditstream/drizzle` | Drizzle 1.x `.comment()` helper (`auditComment()`) and driver wrappers for `pg` / Neon WebSocket (`wrapPgPool`), `postgres.js` (`wrapPostgresJs`), and Neon HTTP (`wrapNeonHttp`) | [README](packages/drizzle/README.md) |

Database migrations, capture triggers, `auditstream verify`, and `auditstream export` live in the [Auditstream Rust engine repository](https://github.com/auditstream/auditstream).

## Install

Install `@auditstream/node` alongside the ORM adapter you use:

```sh
# Prisma 7.1+
pnpm add @auditstream/node @auditstream/prisma @prisma/client

# Drizzle 0.45 or 1.x
pnpm add @auditstream/node @auditstream/drizzle drizzle-orm
```

See each package's README for full setup snippets and middleware examples.

## Examples

Runnable end-to-end apps with real engine-generated migrations and live PostgreSQL smoke tests:

- **[Next.js 16 + Prisma 7 (`examples/next-prisma`)](examples/next-prisma/README.md)** — `withAudit` Route Handlers, `auditAction` Server Actions, `auditTransaction` (`set_config` fallback), `audit.log()` application events, and a **copy-paste BFF-safe Activity Feed** (`/activity` + `GET /api/activity`) powered by `audit.query()` with allowlist DTO projection, server-side actor ID resolution, and keyset pagination (zero `count(*)`). Auditstream intentionally does not publish a styled `@auditstream/react` npm package; see [ADR-0009](https://github.com/auditstream/auditstream/blob/main/docs/decisions/0009-no-ui-package-or-in-db-partition-sealing.md).
- **[Hono + Drizzle 0.45 (`examples/hono-drizzle`)](examples/hono-drizzle/README.md)** — `@auditstream/node/hono` middleware, pool-safe `wrapPgPool` tagging, transactions with nested savepoints, and unscoped writes.

## Supported versions

| Dependency | Supported in v0.1 |
| --- | --- |
| Node.js | `22.12` or newer (CI tests `22`, `24`, and `26`) |
| PostgreSQL | `15` to `19` |
| Prisma | `@prisma/client` `7.1` or newer within `7.x` (Prisma 6 is unsupported; Prisma 8 follows its stable release; the `prisma` CLI is never a peer dependency) |
| Drizzle | `0.45` and `1.x` |
| Runtimes | Node.js (reference), Bun and Deno (tested in CI), Cloudflare Workers (`nodejs_als` flag or compatibility date `2026-08-04` or later) |

## Specification conformance

`@auditstream/node` pins the `spec-v0.1.1` conformance fixtures in [`conformance.json`](conformance.json) (verified by SHA-256) and runs every transport encode/decode test case in CI (`packages/node/test/conformance.test.ts`), including without `globalThis.Buffer`.

## Local development

Requires Node.js 26 (for workspace tooling) and pnpm 12 (`corepack enable`):

```sh
pnpm install --frozen-lockfile
pnpm check               # Biome lint/format, typecheck, build, unit tests, API check, publint/attw, README snippets
pnpm test:integration    # Live PostgreSQL + PgBouncer integration suite (requires Docker)
```

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Auditstream is licensed under the [MIT License](LICENSE).
