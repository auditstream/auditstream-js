# @auditstream/prisma

[![npm version][npm-badge]][npm-url]
[![CI][ci-badge]][ci-url]
[![SonarCloud Quality Gate][sonar-badge]][sonar-url]
[![OpenSSF Scorecard][scorecard-badge]][scorecard-url]

Prisma 7 SQL comments plugin and transaction-local `set_config` fallback for [Auditstream](https://auditstream.dev).

`@auditstream/prisma` reads the active actor from `@auditstream/node` and sends it to database capture triggers without altering your Prisma schema. Full guides and API reference live at **[auditstream.dev/docs/typescript/prisma](https://auditstream.dev/docs/typescript/prisma/)**.

## Install

```sh
pnpm add @auditstream/prisma @auditstream/node @prisma/client
```

Install the `prisma` CLI as a dev dependency if needed. The `prisma` CLI is never a peer dependency.

> **Prerequisite:** Generate the capture migration with `auditstream init --migrations prisma` from the [`auditstream` CLI](https://auditstream.dev/docs/getting-started/), then apply it on a direct (non-pooled) PostgreSQL connection with `prisma migrate deploy`. `auditstream init` only writes migration files; run `auditstream verify` to confirm the audit schema and capture triggers are installed.

## Quick start

### SQL comments plugin (`auditstream`)

Register `auditstream()` in your Prisma 7 client `comments` array. Every write inside `audit.as()` receives one trailing `auditstream` tag:

```ts
import { audit } from "@auditstream/node";
import { auditstream } from "@auditstream/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: "postgres://localhost/app" });
const prisma = new PrismaClient({
  adapter,
  comments: [auditstream()],
});

await audit.as({ type: "user", id: "usr_42" }, () =>
  prisma.invoice.update({
    where: { id: 1 },
    data: { status: "paid" },
  }),
);
```

### Transaction fallback (`auditTransaction`)

Use `auditTransaction()` when SQL comments are unavailable, such as under Prisma Accelerate or proxies that strip comments. It sets `auditstream.actor` with `set_config(..., true)` inside the transaction:

```ts
import { audit } from "@auditstream/node";
import { auditTransaction } from "@auditstream/prisma";
import { PrismaClient } from "./generated/prisma/client.js";

const prisma = new PrismaClient();

await audit.as({ type: "user", id: "usr_42" }, () =>
  auditTransaction(
    prisma,
    async (tx) => {
      await tx.invoice.update({
        where: { id: 1 },
        data: { status: "paid" },
      });
    },
    { timeout: 5000 },
  ),
);
```

## Supported versions

| Dependency | Supported versions |
| --- | --- |
| Node.js | `22.12` or newer (CI tests `22`, `24`, and `26`) |
| PostgreSQL | `15` to `19` |
| Prisma | `@prisma/client` `7.1` or newer within `7.x` (tested on `7.10.1`) |
| Runtimes | Node.js (reference), Bun and Deno (tested in CI), Cloudflare Workers (`nodejs_als` flag or compatibility date `2026-08-04` or later; this adapter is not yet tested on Workers) |

Prisma 6 is not supported. Prisma 8 support follows its stable release. The `prisma` CLI is never a peer dependency.

## Context and limits

- **Unawaited lazy queries:** Prisma queries execute only when awaited. Always await them inside `audit.as()`, which awaits your callback before closing the scope.
- **No `statementNameGenerator`:** Never configure `PrismaPg`'s optional `statementNameGenerator` alongside SQL comments; per-actor comments with named prepared statements grow caches unboundedly.
- **Next.js `proxy`:** `AsyncLocalStorage` does not cross Next.js `proxy`. Pass actor data through headers, cookies, rewrites, redirects, or URLs, and wrap handlers with `@auditstream/node/next`.
- **Background jobs:** Code running outside a request has no active actor. Open a scope with a `service` or `system` actor.
- **Prisma Accelerate:** Comment plugins do not receive the SQL under Accelerate. Use `auditTransaction()` there instead.
- **Nested `audit.as()` inside `auditTransaction()`:** `auditTransaction()` captures the active actor once at transaction entry and sets transaction-local `set_config('auditstream.actor', $1, true)`. Because `set_config` takes precedence over SQL comments (`spec/transport.md`), nested `audit.as(innerActor, ...)` calls inside `fn(tx)` still attribute writes on `tx` to the outer actor; use a separate transaction (or explicitly update and restore `auditstream.actor` via `setConfigValue()` and `set_config(..., true)` on `tx`) when an inner step needs a different actor.
- **AWS RDS Proxy:** Trailing comments are the default transport because `set_config(..., true)` pins RDS Proxy sessions.

## Links

- [Prisma guide (auditstream.dev)](https://auditstream.dev/docs/typescript/prisma/)
- [Monorepo (auditstream-js)](https://github.com/auditstream/auditstream-js)
- [Rust Engine & CLI](https://github.com/auditstream/auditstream)
- [Security policy](https://github.com/auditstream/auditstream-js/security/policy)

[npm-badge]: https://img.shields.io/npm/v/%40auditstream%2Fprisma?style=flat&label=%40auditstream%2Fprisma
[npm-url]: https://www.npmjs.com/package/@auditstream/prisma
[ci-badge]: https://img.shields.io/github/actions/workflow/status/auditstream/auditstream-js/ci.yml?branch=main&style=flat&label=CI
[ci-url]: https://github.com/auditstream/auditstream-js/actions/workflows/ci.yml
[sonar-badge]: https://img.shields.io/sonar/quality_gate/auditstream_auditstream-js?server=https%3A%2F%2Fsonarcloud.io&style=flat&label=SonarCloud
[sonar-url]: https://sonarcloud.io/project/overview?id=auditstream_auditstream-js
[scorecard-badge]: https://img.shields.io/ossf-scorecard/github.com/auditstream/auditstream-js?style=flat&label=OpenSSF%20Scorecard
[scorecard-url]: https://scorecard.dev/viewer/?uri=github.com/auditstream/auditstream-js
