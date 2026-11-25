# @auditstream/node

[![npm version][npm-badge]][npm-url]
[![CI][ci-badge]][ci-url]
[![SonarCloud Quality Gate][sonar-badge]][sonar-url]
[![OpenSSF Scorecard][scorecard-badge]][scorecard-url]

Actor context propagation, application event logging, history helpers, and web framework integrations for [Auditstream](https://auditstream.dev).

`@auditstream/node` tracks who initiated each request with `AsyncLocalStorage`. ORM adapters read that scope and attach it to outgoing SQL so database capture triggers record who acted — including delegated AI agents (`onBehalfOf`). Full guides and API reference live at **[auditstream.dev/docs/typescript](https://auditstream.dev/docs/typescript/)**.

## Install

```sh
pnpm add @auditstream/node
```

Framework subpaths use optional peer dependencies — install only the framework your app uses (`express`, `hono`, or `next`).

> **Prerequisite:** Run `auditstream init` from the [`auditstream` CLI](https://auditstream.dev/docs/getting-started/) to create the audit schema and database capture triggers.

## Quick start

### Actor scope (`audit.as` and `audit.current`)

Wrap request or job work in `audit.as()` and inspect the active scope with `audit.current()`:

```ts
import { audit } from "@auditstream/node";

export async function runBillingJob(): Promise<string | undefined> {
  return await audit.as(
    {
      type: "ai_agent",
      id: "billing-agent",
      onBehalfOf: { type: "user", id: "usr_42", tenant: "org_acme" },
    },
    async () => audit.current()?.actor.id,
    { context: { requestId: "req_123", source: "api" } },
  );
}
```

### Application events (`audit.log`)

Record domain events that do not modify a table through `auditstream.log_event()`:

```ts
import { audit } from "@auditstream/node";
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://localhost/app" });

await audit.as({ type: "user", id: "usr_42" }, () =>
  audit.log((sql, values) => pool.query(sql, values), {
    action: "invoice.exported",
    target: { invoice_id: 42 },
    data: { format: "csv" },
  }),
);
```

### Record history and activity queries (`audit.history`, `audit.query`)

Read one record's timeline with `audit.history()`, or run filtered, keyset-paginated queries across database trigger rows (`source: "db"`) and application events (`source: "app"`) with `audit.query()`. Export parsing (`parseExportRecord()`) and transport codecs (`encodeScope()`, `decodeScope()`, `tagSql()`, `isTagged()`, `setConfigValue()`) are documented at [auditstream.dev/docs/typescript](https://auditstream.dev/docs/typescript/).

> **Backend-only API:** `audit.query()` returns raw `HistoryEntry` rows with internal database metadata and raw `before`/`after` snapshots. Enforce authentication and tenant authorization on the server, and project each entry to an allowlisted client DTO before sending data to browsers. For high-QPS tenant feeds, add the [opt-in tenant indexes](https://github.com/auditstream/auditstream/blob/main/docs/reference/cli/history.md#opt-in-tenant-indexes).

```ts
import { audit } from "@auditstream/node";
import pg from "pg";

const pool = new pg.Pool({ connectionString: "postgres://localhost/app" });

export async function loadInvoiceActivity() {
  const history = await audit.history((sql, values) => pool.query(sql, values), {
    table: "invoice",
    recordId: { id: 42 },
  });
  const page = await audit.query((sql, values) => pool.query(sql, values), {
    tenant: "org_acme",
    source: "app",
    opPrefix: "invoice.",
    since: "2026-11-01T00:00:00Z",
    limit: 25,
  });
  return { history, page };
}
```

### Framework integrations

> **Security:** Always resolve `actor.id` and `actor.tenant` from a verified session, signed cookie, or validated JWT — never directly from unverified client headers. If a reverse proxy or Next.js `proxy` forwards identity in a header, it must strip or overwrite that header on every incoming request.

#### Express (`@auditstream/node/express`)

```ts
import { auditstream } from "@auditstream/node/express";
import express, { type Request } from "express";

interface AuthedRequest extends Request {
  user?: { id: string; tenantId?: string };
}

const app = express();
// Mount after authentication middleware populates `req.user` from a verified session or JWT.
app.use(
  auditstream({
    actor: (req) => {
      const user = (req as AuthedRequest).user;
      return user ? { type: "user", id: user.id, ...(user.tenantId ? { tenant: user.tenantId } : {}) } : undefined;
    },
    context: (req) => ({ requestId: req.header("x-request-id") ?? "req_unknown" }),
  }),
);
```

#### Hono (`@auditstream/node/hono`)

```ts
import { auditstream } from "@auditstream/node/hono";
import { Hono } from "hono";

declare function verifySession(auth: string | undefined): Promise<{ id: string; tenantId?: string } | null>;

const app = new Hono();
app.use(
  "*",
  auditstream({
    actor: async (c) => {
      const s = await verifySession(c.req.header("authorization"));
      return s ? { type: "user", id: s.id, ...(s.tenantId ? { tenant: s.tenantId } : {}) } : undefined;
    },
  }),
);
```

#### Next.js Route Handlers and Server Actions (`@auditstream/node/next`)

```ts
import { auditAction, withAudit } from "@auditstream/node/next";

declare function getVerifiedSession(req?: Request): Promise<{ userId: string; tenantId?: string } | null>;

export const POST = withAudit(async (_req: Request) => new Response("ok"), {
  actor: async (req) => {
    const s = await getVerifiedSession(req);
    return s ? { type: "user", id: s.userId, ...(s.tenantId ? { tenant: s.tenantId } : {}) } : undefined;
  },
});

export const approveInvoice = auditAction(async (invoiceId: number) => invoiceId, {
  actor: async () => {
    const s = await getVerifiedSession();
    return s ? { type: "user", id: s.userId } : undefined;
  },
});
```

## Supported versions

| Dependency | Supported versions |
| --- | --- |
| Node.js | `22.12` or newer (CI tests `22`, `24`, and `26`) |
| PostgreSQL | `15` to `19` |
| Prisma | `@prisma/client` `7.1` or newer within `7.x` (via `@auditstream/prisma`) |
| Drizzle | `0.45` and `1.x` (via `@auditstream/drizzle`) |
| Runtimes | Node.js (reference), Bun and Deno (tested in CI), Cloudflare Workers (`nodejs_als` flag or compatibility date `2026-08-04` or later) |

`@auditstream/node` is ESM-only and uses `AsyncLocalStorage.run()` exclusively so all adapters share one scope.

## Context and limits

- **Unawaited lazy queries:** Always await ORM queries inside `audit.as()`, which awaits its callback before exiting the scope.
- **Next.js `proxy`:** `proxy` cannot carry `AsyncLocalStorage` into Route Handlers or Server Actions; wrap handlers with `withAudit()` or `auditAction()`.
- **Background jobs:** Work outside a request has no ambient scope; open a fresh `audit.as()` scope with a `service` or `system` actor.
- **AWS RDS Proxy & Prisma Accelerate:** Trailing SQL comments are the default because `set_config(..., true)` pins RDS Proxy sessions. Use `auditTransaction()` from `@auditstream/prisma` under Prisma Accelerate.

## Links

- [TypeScript SDK docs (auditstream.dev)](https://auditstream.dev/docs/typescript/)
- [Next.js guide](https://auditstream.dev/docs/typescript/nextjs/) · [Express & Hono guide](https://auditstream.dev/docs/typescript/http/)
- [Monorepo (auditstream-js)](https://github.com/auditstream/auditstream-js)
- [Rust Engine & CLI](https://github.com/auditstream/auditstream)
- [Security policy](https://github.com/auditstream/auditstream-js/security/policy)

[npm-badge]: https://img.shields.io/npm/v/%40auditstream%2Fnode?style=flat&label=%40auditstream%2Fnode
[npm-url]: https://www.npmjs.com/package/@auditstream/node
[ci-badge]: https://img.shields.io/github/actions/workflow/status/auditstream/auditstream-js/ci.yml?branch=main&style=flat&label=CI
[ci-url]: https://github.com/auditstream/auditstream-js/actions/workflows/ci.yml
[sonar-badge]: https://img.shields.io/sonar/quality_gate/auditstream_auditstream-js?server=https%3A%2F%2Fsonarcloud.io&style=flat&label=SonarCloud
[sonar-url]: https://sonarcloud.io/project/overview?id=auditstream_auditstream-js
[scorecard-badge]: https://img.shields.io/ossf-scorecard/github.com/auditstream/auditstream-js?style=flat&label=OpenSSF%20Scorecard
[scorecard-url]: https://scorecard.dev/viewer/?uri=github.com/auditstream/auditstream-js
