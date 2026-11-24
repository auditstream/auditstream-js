# auditstream-js

TypeScript adapters for [Auditstream](https://github.com/auditstream/auditstream), an open-source PostgreSQL audit trail engine.

This repository publishes three ESM-only packages released together:

- [`@auditstream/node`](packages/node/README.md) — Actor context propagation (`AsyncLocalStorage`), `audit.as()`, `audit.log()`, history helpers, and Express, Hono, and Next.js integrations.
- [`@auditstream/prisma`](packages/prisma/README.md) — Prisma 7 SQL comments plugin and `set_config` transaction fallback.
- [`@auditstream/drizzle`](packages/drizzle/README.md) — Drizzle 1.x `.comment()` helper and driver wrappers for `pg`, `postgres.js`, Neon WebSocket, and Neon HTTP.

Database triggers, migrations, and the CLI live in the [Auditstream engine repository](https://github.com/auditstream/auditstream).
