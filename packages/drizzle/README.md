# @auditstream/drizzle

[![npm version][npm-badge]][npm-url]
[![CI][ci-badge]][ci-url]
[![SonarCloud Quality Gate][sonar-badge]][sonar-url]
[![OpenSSF Scorecard][scorecard-badge]][scorecard-url]

Drizzle ORM driver wrappers and Drizzle 1.x `.comment()` helper for [Auditstream](https://auditstream.dev).

`@auditstream/drizzle` forwards the active actor from `@auditstream/node` to database capture triggers across Drizzle 0.45 and 1.x. Full guides and API reference live at **[auditstream.dev/docs/typescript/drizzle](https://auditstream.dev/docs/typescript/drizzle/)**.

## Install

```sh
pnpm add @auditstream/drizzle @auditstream/node drizzle-orm
```

Install the PostgreSQL driver your project uses:

```sh
pnpm add pg
pnpm add postgres
pnpm add @neondatabase/serverless
```

> **Prerequisite:** Run `auditstream init` from the [`auditstream` CLI](https://auditstream.dev/docs/getting-started/) to create the audit schema and database capture triggers.

## Quick start

### Drizzle 1.x `.comment()` helper (`@auditstream/drizzle`)

Use `auditComment()` with Drizzle 1.x query builders and relational queries when you do not need a driver wrapper:

```ts
import { auditComment } from "@auditstream/drizzle";
import { audit } from "@auditstream/node";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const db = drizzle("postgres://localhost/app");

await audit.as({ type: "user", id: "usr_42" }, () =>
  db
    .update(invoice)
    .set({ status: "paid" })
    .where(eq(invoice.id, 1))
    .comment(
      auditComment({
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      }),
    ),
);
```

### `node-postgres` and Neon WebSocket (`@auditstream/drizzle/pg`)

Wrap `pg.Pool` (or Neon's WebSocket `Pool`) with `wrapPgPool()`. It reads the actor at query entry and drops statement names on tagged writes:

```ts
import { wrapPgPool } from "@auditstream/drizzle/pg";
import { audit } from "@auditstream/node";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const pool = wrapPgPool(new pg.Pool({ connectionString: "postgres://localhost/app" }));
const db = drizzle({ client: pool });

await audit.as({ type: "user", id: "usr_42" }, () =>
  db.update(invoice).set({ status: "paid" }).where(eq(invoice.id, 1)),
);
```

### `postgres.js` (`@auditstream/drizzle/postgres-js`)

Wrap a `postgres.js` client with `wrapPostgresJs()`. It works with both `prepare: true` and `prepare: false`, directly and behind PgBouncer:

```ts
import { wrapPostgresJs } from "@auditstream/drizzle/postgres-js";
import { audit } from "@auditstream/node";
import { eq } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const sql = wrapPostgresJs(postgres("postgres://localhost/app", { prepare: true }));
const db = drizzle(sql);

await audit.as({ type: "user", id: "usr_42" }, () =>
  db.update(invoice).set({ status: "paid" }).where(eq(invoice.id, 1)),
);
```

### Neon HTTP (`@auditstream/drizzle/neon-http`)

Wrap `neon()` with `wrapNeonHttp()`. It tags `sql.query()`, plain string calls, HTTP transactions, and Drizzle `db.batch()`:

```ts
import { wrapNeonHttp } from "@auditstream/drizzle/neon-http";
import { audit } from "@auditstream/node";
import { neon } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-http";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const sql = wrapNeonHttp(neon("postgres://user:pass@ep-example.neon.tech/neondb"));
const db = drizzle({ client: sql });

await audit.as({ type: "user", id: "usr_42" }, () =>
  db.update(invoice).set({ status: "paid" }).where(eq(invoice.id, 1)),
);
```

## Supported versions

| Dependency | Supported versions |
| --- | --- |
| Node.js | `22.12` or newer (CI tests `22`, `24`, and `26`) |
| PostgreSQL | `15` to `19` |
| Drizzle | `0.45` (`^0.45.2`) and `1.x` (`>=1.0.0-rc.1 <2.0.0`) |
| Runtimes | Node.js (reference), Bun and Deno (tested in CI), Cloudflare Workers (`nodejs_als` flag or compatibility date `2026-08-04` or later) |

## Context and limits

- **Unawaited lazy queries:** Always await Drizzle queries inside `audit.as()`. Returning an unawaited query exits the actor scope before execution.
- **Next.js `proxy`:** `AsyncLocalStorage` does not cross Next.js `proxy`. Pass actor data through headers, cookies, rewrites, redirects, or URLs, and wrap handlers with `@auditstream/node/next`.
- **Background jobs:** Jobs outside a request have no ambient actor. Open a scope with a `service` or `system` actor.
- **Drizzle 1.x raw SQL and transactions:** `db.execute(sql)` and transaction control have no `.comment()` method. Use a driver wrapper, which skips statements already tagged by `auditComment()`.
- **AWS RDS Proxy:** Trailing SQL comments are the default transport because `set_config(..., true)` pins RDS Proxy sessions.

## Links

- [Drizzle guide (auditstream.dev)](https://auditstream.dev/docs/typescript/drizzle/)
- [Monorepo (auditstream-js)](https://github.com/auditstream/auditstream-js)
- [Rust Engine & CLI](https://github.com/auditstream/auditstream)
- [Security policy](https://github.com/auditstream/auditstream-js/security/policy)

[npm-badge]: https://img.shields.io/npm/v/%40auditstream%2Fdrizzle?style=flat&label=%40auditstream%2Fdrizzle
[npm-url]: https://www.npmjs.com/package/@auditstream/drizzle
[ci-badge]: https://img.shields.io/github/actions/workflow/status/auditstream/auditstream-js/ci.yml?branch=main&style=flat&label=CI
[ci-url]: https://github.com/auditstream/auditstream-js/actions/workflows/ci.yml
[sonar-badge]: https://img.shields.io/sonar/quality_gate/auditstream_auditstream-js?server=https%3A%2F%2Fsonarcloud.io&style=flat&label=SonarCloud
[sonar-url]: https://sonarcloud.io/project/overview?id=auditstream_auditstream-js
[scorecard-badge]: https://img.shields.io/ossf-scorecard/github.com/auditstream/auditstream-js?style=flat&label=OpenSSF%20Scorecard
[scorecard-url]: https://scorecard.dev/viewer/?uri=github.com/auditstream/auditstream-js
