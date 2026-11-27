# Hono + Drizzle Example

This example shows [Hono](https://hono.dev/) running on Node.js with Drizzle ORM 0.45 and Auditstream.

## What it shows

- Request-scoped actor capture using `@auditstream/node/hono`.
- Pool-safe SQL comment tagging via `wrapPgPool(new pg.Pool({ max: 5 }))` from `@auditstream/drizzle/pg`.
- Routes that create, update, finalize, and delete invoices.
- A Drizzle transaction with a nested savepoint (`POST /invoices/:id/finalize`).
- Unscoped writes when no actor header is present, recording `actor` as `NULL`.
- Real engine-generated Drizzle migrations stored in `drizzle/`.

> **Demo-only authentication:** This example reads the actor from the `x-demo-user` HTTP header.
> Never trust a client-supplied header in production.
> Real apps must resolve the actor from a verified session, cookie, or JWT.

## Prerequisites

- Node.js 22.12 or later.
- pnpm 12.x (`corepack enable`).
- PostgreSQL 15 or later (or Docker to run one locally).

## Run it locally

1. Install workspace dependencies and build the packages from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

2. Start PostgreSQL and export `DATABASE_URL`:

```bash
docker run --rm --name auditstream-demo-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=auditstream_demo \
  -p 5432:5432 \
  -d postgres:17-alpine

export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/auditstream_demo"
```

3. Apply the Drizzle migrations (application tables plus Auditstream triggers):

```bash
pnpm --filter @auditstream/example-hono-drizzle migrate
```

4. Start the Hono server on port 3000:

```bash
pnpm --filter @auditstream/example-hono-drizzle start
```

5. Exercise the routes in another terminal:

```bash
# Create an invoice as alice
curl -s -X POST http://127.0.0.1:3000/invoices \
  -H 'content-type: application/json' \
  -H 'x-demo-user: alice' \
  -d '{"status":"draft","total":"50.00"}'

# Update the invoice as bob
curl -s -X PATCH http://127.0.0.1:3000/invoices/1 \
  -H 'content-type: application/json' \
  -H 'x-demo-user: bob' \
  -d '{"status":"review","total":"125.00"}'

# Finalize inside a Drizzle transaction with a savepoint as carol
curl -s -X POST http://127.0.0.1:3000/invoices/1/finalize \
  -H 'content-type: application/json' \
  -H 'x-demo-user: carol' \
  -d '{"description":"Annual plan","amount":"250.00"}'

# Delete the invoice as dave
curl -s -X DELETE http://127.0.0.1:3000/invoices/1 \
  -H 'x-demo-user: dave'

# Create an unscoped invoice (no x-demo-user header)
curl -s -X POST http://127.0.0.1:3000/invoices \
  -H 'content-type: application/json' \
  -d '{"status":"system","total":"10.00"}'
```

## Run the smoke test

The smoke test starts PostgreSQL with `@auditstream/test-utils`, applies migrations, and sends 40 concurrent requests:

```bash
pnpm --filter ./examples/hono-drizzle test:smoke
```

## Cloudflare Workers note

The same `@auditstream/node/hono` middleware runs on Cloudflare Workers. CI runs it in workerd (`pnpm test:workers`) with the `@auditstream/node/pg` wrapper over an in-memory pool, under both settings below.
Enable the `nodejs_als` compatibility flag, or set a compatibility date of `2026-08-04` or later.

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
  3 | invoice    | UPDATE | {"id": 1} | carol    | comment
  4 | line_item  | INSERT | {"id": 1} | carol    | comment
  5 | invoice    | DELETE | {"id": 1} | dave     | comment
  6 | line_item  | DELETE | {"id": 1} | dave     | comment
  7 | invoice    | INSERT | {"id": 2} |          |
(7 rows)
```
