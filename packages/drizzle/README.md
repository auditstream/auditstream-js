# @auditstream/drizzle

Drizzle ORM driver wrappers and Drizzle 1.x `.comment()` helper for [Auditstream](https://github.com/auditstream/auditstream).

`@auditstream/drizzle` forwards the active actor from `@auditstream/node` to PostgreSQL triggers across Drizzle 0.45 and 1.x.

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

## Supported versions

| Dependency | Supported in v0.1 |
| --- | --- |
| Node.js | `22.12` or newer (CI tests `22`, `24`, and `26`) |
| PostgreSQL | `15` to `19` |
| Drizzle | `0.45` (`^0.45.2`) and `1.x` (`>=1.0.0-rc.1 <2.0.0`) |
| Prisma | `@prisma/client` `7.1` or newer within `7.x` (Prisma 6 is unsupported; Prisma 8 follows its stable release; the `prisma` CLI is never a peer) |
| Runtimes | Node.js (reference), Bun and Deno (tested in CI), Cloudflare Workers (`nodejs_als` flag or compatibility date `2026-08-04` or later) |

## Quick start

### Drizzle 1.x `.comment()` helper (`@auditstream/drizzle`)

Use `auditComment()` with Drizzle 1.x query builders and relational queries when you do not need a driver wrapper.

```ts
import {
  auditComment,
  PACKAGE_NAME,
  type SqlCommenterValue,
  type SqlCommenterValues,
} from "@auditstream/drizzle";
import { audit } from "@auditstream/node";
import { eq } from "drizzle-orm-v1";
import { drizzle } from "drizzle-orm-v1/node-postgres";
import { integer, pgTable, text } from "drizzle-orm-v1/pg-core";

const invoice = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
});

const db = drizzle.mock();
const traceVal: SqlCommenterValue = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

await audit.as({ type: "user", id: "usr_42" }, () => {
  const tags: SqlCommenterValues = auditComment({ traceparent: traceVal });
  const query = db.update(invoice).set({ status: "paid" }).where(eq(invoice.id, 1)).comment(tags);
  void [query.toSQL(), PACKAGE_NAME];
});
```

### `node-postgres` and Neon WebSocket (`@auditstream/drizzle/pg`)

Wrap `pg.Pool` (or Neon's WebSocket `Pool`) with `wrapPgPool()`. It reads the actor at query entry and drops statement names on tagged writes.

```ts
import {
  type PgClientLike,
  type PgPoolLike,
  type PgQueryConfig,
  type PgSubmittable,
  SUBPATH,
  wrapPgPool,
} from "@auditstream/drizzle/pg";
import { audit } from "@auditstream/node";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

const pool = wrapPgPool(new pg.Pool({ connectionString: "postgres://localhost/app" }));
const db = drizzle({ client: pool });

async function run(config: PgQueryConfig): Promise<void> {
  const poolRef: PgPoolLike = pool;
  await audit.as({ type: "user", id: "usr_42" }, async () => {
    void [db, poolRef, config, SUBPATH];
  });
}

type CheckTypes = [PgClientLike, PgSubmittable];
void [run, null as unknown as CheckTypes];
```

### `postgres.js` (`@auditstream/drizzle/postgres-js`)

Wrap a `postgres.js` client with `wrapPostgresJs()`. It works with both `prepare: true` and `prepare: false`, directly and behind PgBouncer.

```ts
import {
  type PostgresJsLike,
  type PostgresJsTransactionLike,
  type PostgresJsUnsafeOptions,
  SUBPATH,
  wrapPostgresJs,
} from "@auditstream/drizzle/postgres-js";
import { audit } from "@auditstream/node";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const sql = wrapPostgresJs(postgres("postgres://localhost/app", { prepare: true }));
const db = drizzle(sql);

const clientRef: PostgresJsLike = sql;
const txRef: PostgresJsTransactionLike = sql;
const opts: PostgresJsUnsafeOptions = { prepare: false };

await audit.as({ type: "user", id: "usr_42" }, async () => {
  void [db, clientRef, txRef, opts, SUBPATH];
});
```

### Neon HTTP (`@auditstream/drizzle/neon-http`)

Wrap `neon()` with `wrapNeonHttp()`. It tags template queries, `sql.query()`, HTTP transactions, and Drizzle `db.batch()`.

```ts
import {
  type NeonHttpClientLike,
  SUBPATH,
  wrapNeonHttp,
} from "@auditstream/drizzle/neon-http";
import { audit } from "@auditstream/node";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

const sql = wrapNeonHttp(neon("postgres://user:pass@ep-example.neon.tech/neondb"));
const db = drizzle({ client: sql });
const clientRef: NeonHttpClientLike = sql;

await audit.as({ type: "user", id: "usr_42" }, async () => {
  void [db, clientRef, SUBPATH];
});
```

## Context and limits

- **Unawaited lazy queries:** Always await Drizzle queries inside `audit.as()`. Returning an unawaited query exits the actor scope before execution.
- **Next.js `proxy`:** `AsyncLocalStorage` does not cross Next.js `proxy`. Pass actor data through headers, cookies, rewrites, redirects, or URLs, and wrap handlers with `@auditstream/node/next`.
- **Background jobs:** Jobs outside a request have no ambient actor. Open a scope with a `service` or `system` actor.
- **Drizzle 1.x raw SQL and transactions:** `db.execute(sql)` and transaction control have no `.comment()` method. Use a driver wrapper, which skips statements already tagged by `auditComment()`.
- **Prisma Accelerate and AWS RDS Proxy:** Trailing SQL comments are the default because `set_config(..., true)` pins RDS Proxy sessions. Apps behind Prisma Accelerate use `auditTransaction()` from `@auditstream/prisma`.

## Links

- [Auditstream engine repository](https://github.com/auditstream/auditstream)
- [Engineering handbook](https://github.com/auditstream/auditstream/tree/main/docs/handbook)
- [Adapters design](https://github.com/auditstream/auditstream/blob/main/docs/handbook/adapters.md)
- [Transport specification](https://github.com/auditstream/auditstream/blob/main/spec/transport.md)
- [Supported versions](https://github.com/auditstream/auditstream/blob/main/docs/handbook/releases.md#supported-versions)
