# Next.js 16 + Prisma 7 Example

This example shows Next.js 16 App Router running with Prisma 7 and Auditstream.

## What it shows

- Prisma 7 using the `prisma-client` generator, `prisma.config.ts`, `PrismaPg` (`max: 5`), and `comments: [auditstream()]`.
- Route Handlers (`POST /api/invoices`, `PATCH /api/invoices/[id]`) wrapped with `withAudit` from `@auditstream/node/next`.
- A Server Action (`src/app/actions.ts`) wrapped with `auditAction` from `@auditstream/node/next`.
- A `set_config` fallback route (`POST /api/invoices/[id]/approve`) using `auditTransaction` from `@auditstream/prisma`.
- Real engine-generated Prisma migrations stored in `prisma/migrations/`.

> **Demo-only authentication:** This example reads the actor from the `x-demo-user` HTTP header.
> Never trust a client-supplied header in production.
> Real apps must resolve the actor from a verified session or JWT.
> Actors carry IDs only: never include names, emails, or IP addresses.

## Why `withAudit` and `auditAction` instead of `proxy`

In Next.js 16, `proxy` cannot hold an `AsyncLocalStorage` scope for downstream Route Handlers or Server Actions.
Data leaves `proxy` only through headers, cookies, rewrites, redirects, or the URL.
Wrap each Route Handler with `withAudit` and each Server Action with `auditAction`.
If `proxy` forwards an identity header, it must overwrite or strip that header on every request.

## Prerequisites

- Node.js 22.12 or later.
- pnpm 12.x (`corepack enable`).
- PostgreSQL 15 or later (or Docker to run one locally).

## Run it locally

1. Install workspace dependencies and build the workspace packages from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

2. Start PostgreSQL and export `DATABASE_URL`:

```bash
docker run --rm --name auditstream-next-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=auditstream_demo \
  -p 5432:5432 \
  -d postgres:17-alpine

export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/auditstream_demo"
```

3. Deploy the Prisma migrations (application table plus Auditstream triggers):

```bash
pnpm --filter @auditstream/example-next-prisma prisma:migrate
```

4. Start the Next.js server on port 3000:

```bash
pnpm --filter @auditstream/example-next-prisma start
```

5. Exercise the routes in another terminal:

```bash
# Create an invoice via withAudit (records actor_source = 'comment')
curl -s -X POST http://127.0.0.1:3000/api/invoices \
  -H 'content-type: application/json' \
  -H 'x-demo-user: alice' \
  -d '{"status":"draft","total":"50.00"}'

# Update the invoice via withAudit (records actor_source = 'comment')
curl -s -X PATCH http://127.0.0.1:3000/api/invoices/1 \
  -H 'content-type: application/json' \
  -H 'x-demo-user: bob' \
  -d '{"status":"review","total":"125.00"}'

# Approve via auditTransaction set_config fallback (records actor_source = 'set_config')
curl -s -X POST http://127.0.0.1:3000/api/invoices/1/approve \
  -H 'content-type: application/json' \
  -H 'x-demo-user: carol' \
  -d '{"status":"approved"}'

# Create an unscoped invoice (no x-demo-user header -> actor is NULL)
curl -s -X POST http://127.0.0.1:3000/api/invoices \
  -H 'content-type: application/json' \
  -d '{"status":"system","total":"10.00"}'
```

You can also open `http://127.0.0.1:3000/` to submit the `auditAction` Server Action form.

## Run the smoke test

The smoke test starts Postgres with `@auditstream/test-utils`, runs `prisma migrate deploy`, builds Next.js, and runs 40 concurrent requests:

```bash
pnpm --filter ./examples/next-prisma test:smoke
```

## Inspect captured changes

Run this `psql` query to inspect `auditstream.changes`:

```bash
psql "$DATABASE_URL" -c "
  SELECT id, table_name, op, record_id, actor->>'id' AS actor_id, actor_source
  FROM auditstream.changes
  ORDER BY id ASC;
"
```

Expected output after the `curl` commands above:

```text
 id | table_name |   op   | record_id | actor_id | actor_source
----+------------+--------+-----------+----------+--------------
  1 | invoice    | INSERT | {"id": 1} | alice    | comment
  2 | invoice    | UPDATE | {"id": 1} | bob      | comment
  3 | invoice    | UPDATE | {"id": 1} | carol    | set_config
  4 | invoice    | INSERT | {"id": 2} |          |
(4 rows)
```
