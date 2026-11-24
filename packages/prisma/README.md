# @auditstream/prisma

Prisma 7 SQL comments plugin and transaction-local `set_config` fallback for [Auditstream](https://github.com/auditstream/auditstream).

`@auditstream/prisma` reads the active actor from `@auditstream/node` and sends it to PostgreSQL triggers without altering your Prisma schema.

## Install

```sh
pnpm add @auditstream/prisma @auditstream/node @prisma/client
```

Install the `prisma` CLI as a dev dependency if needed. The `prisma` CLI is never a peer dependency.

## Supported versions

| Dependency | Supported in v0.1 |
| --- | --- |
| Node.js | `22.12` or newer (CI tests `22`, `24`, and `26`) |
| PostgreSQL | `15` to `19` |
| Prisma | `@prisma/client` `7.1` or newer within `7.x` (tested on `7.10.1`) |
| Drizzle | `0.45` and `1.x` (via `@auditstream/drizzle`) |
| Runtimes | Node.js (reference), Bun and Deno (tested in CI), Cloudflare Workers (`nodejs_als` flag or compatibility date `2026-08-04` or later) |

Prisma 6 is not supported. Prisma 8 support follows its stable release. The `prisma` CLI is never a peer dependency.

## Quick start

### SQL comments plugin (`auditstream`)

Register `auditstream()` in your Prisma 7 client `comments` array. Every write inside `audit.as()` receives one trailing `auditstream` tag.

```ts
import { audit } from "@auditstream/node";
import {
  auditstream,
  PACKAGE_NAME,
  type SqlCommenterContext,
  type SqlCommenterPlugin,
  type SqlCommenterTags,
} from "@auditstream/prisma";

const plugin: SqlCommenterPlugin = auditstream();
const ctx: SqlCommenterContext = { sql: "UPDATE invoice SET status = $1 WHERE id = $2" };

const tags: SqlCommenterTags = await audit.as({ type: "user", id: "usr_42" }, () => plugin(ctx));
void [tags, PACKAGE_NAME];
```

Pass the plugin when constructing `PrismaClient`:

```ts
import { audit } from "@auditstream/node";
import { auditstream } from "@auditstream/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

interface AppPrismaClient {
  invoice: { update(args: { where: { id: number }; data: { status: string } }): Promise<unknown> };
}

function createClient(
  PrismaClientCtor: new (options: {
    adapter: PrismaPg;
    comments: ReturnType<typeof auditstream>[];
  }) => AppPrismaClient,
  connectionString: string,
): AppPrismaClient {
  const pool = new pg.Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  return new PrismaClientCtor({ adapter, comments: [auditstream()] });
}

async function markPaid(prisma: AppPrismaClient): Promise<void> {
  await audit.as({ type: "user", id: "usr_42" }, () =>
    prisma.invoice.update({ where: { id: 1 }, data: { status: "paid" } }),
  );
}

void [createClient, markPaid];
```

### Transaction fallback (`auditTransaction`)

Use `auditTransaction()` when SQL comments are unavailable, such as under Prisma Accelerate. It sets `auditstream.actor` with `set_config(..., true)` inside the transaction.

```ts
import { audit } from "@auditstream/node";
import {
  auditTransaction,
  type PrismaRawExecutor,
  type PrismaTransactionRunner,
} from "@auditstream/prisma";

interface TxClient extends PrismaRawExecutor {
  markPaid(id: number): Promise<void>;
}

async function updateWithFallback(
  prisma: PrismaTransactionRunner<TxClient, { timeout?: number }>,
): Promise<void> {
  await audit.as({ type: "user", id: "usr_42" }, () =>
    auditTransaction(
      prisma,
      async (tx) => {
        await tx.markPaid(1);
      },
      { timeout: 5000 },
    ),
  );
}

void updateWithFallback;
```

## Context and limits

- **Unawaited lazy queries:** Prisma queries execute only when awaited. Always await them inside `audit.as()`, which awaits your callback before closing the scope.
- **Next.js `proxy`:** `AsyncLocalStorage` does not cross Next.js `proxy`. Pass actor data through headers, cookies, rewrites, redirects, or URLs, and wrap handlers with `@auditstream/node/next`.
- **Background jobs:** Code running outside a request has no active actor. Open a scope with a `service` or `system` actor.
- **Prisma Accelerate:** Comment plugins do not receive the SQL under Accelerate. Use `auditTransaction()` there instead.
- **AWS RDS Proxy:** Trailing comments are the default transport because `set_config(..., true)` pins RDS Proxy sessions.

## Links

- [Auditstream engine repository](https://github.com/auditstream/auditstream)
- [Engineering handbook](https://github.com/auditstream/auditstream/tree/main/docs/handbook)
- [Adapters design](https://github.com/auditstream/auditstream/blob/main/docs/handbook/adapters.md)
- [Transport specification](https://github.com/auditstream/auditstream/blob/main/spec/transport.md)
- [Supported versions](https://github.com/auditstream/auditstream/blob/main/docs/handbook/releases.md#supported-versions)
