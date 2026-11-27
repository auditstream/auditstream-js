# AGENTS.md

Instructions for AI coding agents working in `auditstream/auditstream-js`.
This is the only committed instruction file; do not commit `CLAUDE.md`. A personal `CLAUDE.md` or `CLAUDE.local.md` must start with `@AGENTS.md`, or Claude Code stops reading this file.

The authoritative engineering handbook lives in `auditstream/auditstream`: [Handbook](https://github.com/auditstream/auditstream/blob/main/docs/handbook/README.md), [Adapters](https://github.com/auditstream/auditstream/blob/main/docs/handbook/adapters.md), [Engineering standards](https://github.com/auditstream/auditstream/blob/main/docs/handbook/engineering-standards.md), [Workflow](https://github.com/auditstream/auditstream/blob/main/docs/handbook/workflow.md), [Parallel work](https://github.com/auditstream/auditstream/blob/main/docs/handbook/parallel-work.md) and [AI usage policy](https://github.com/auditstream/auditstream/blob/main/docs/handbook/ai-policy.md).

## Commands

Local quality gates (workspace added in JA1, CI checks in JA2):

```sh
pnpm install --frozen-lockfile                            # install workspace dependencies
pnpm check                                                # biome ci, typecheck, build and tests via Turborepo
pnpm test:workers                                         # Cloudflare Workers (workerd) runtime smoke test
pnpm --filter @auditstream/test-utils test:integration    # Postgres + PgBouncer harness test
pnpm changeset                                            # add a changeset (required for package changes)
```

Toolchain: Node 26 for development (`.nvmrc`); published packages support Node `>=22.12`. pnpm 12 with catalogs, Turborepo 2.11, tsdown 0.23 (exact), Biome 2.6, TypeScript `~6.0`, Vitest 5, workerd (exact, catalog-pinned for Workers smoke tests).

## Repository map

```text
package.json                root workspace scripts (`pnpm check`, `pnpm test:workers`)
pnpm-workspace.yaml         workspaces (`packages/*`, `examples/*`) and dependency catalog
turbo.json                  Turborepo task graph
biome.json                  Biome formatting and lint rules
tsconfig.base.json          strict TS 6.0 config (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedDeclarations`)
scripts/                    workspace verification and runtime smoke runners (`smoke-runtimes.mjs`, `smoke-workers.mjs`, `check-packages.mjs`)
packages/
  node/                     @auditstream/node: AsyncLocalStorage context, audit.as(), audit.log(), /express, /hono, /next, /pg, /postgres-js, /neon-http
  prisma/                   @auditstream/prisma: Prisma 7.1+ SQL comments plugin and set_config fallback
  drizzle/                  @auditstream/drizzle: Drizzle 1.x helper and backwards-compatible re-exports of /pg, /neon-http, /postgres-js wrappers
  test-utils/               private Postgres + PgBouncer test harness
examples/                   example apps (Next.js + Prisma, Hono + Drizzle)
```

## Postgres tests

- Integration tests use `TEST_DATABASE_URL` when set, otherwise `@testcontainers/postgresql` (configurable with `TEST_PG_IMAGE`).
- `createTestDatabase()` clones a fresh database per test from a template holding the prototype schema; `startPgBouncer()` adds PgBouncer 1.26+ in transaction mode.
- Every adapter runs at least 40 concurrent requests with distinct actors over a pool smaller than the request count and expects zero wrong actors.

## Adapter rules

Full rationale in [Adapters (TypeScript)](https://github.com/auditstream/auditstream/blob/main/docs/handbook/adapters.md):

- **Scopes await inside:** `audit.as()` awaits its callback inside the `AsyncLocalStorage` scope so lazy queries do not lose their actor.
- **Read actor at caller entry:** driver wrappers read the actor at `pool.query` entry (never `client.query`) and never tag a statement twice.
- **No named prepared statements with per-actor comments:** drop statement names (or set `prepare: false`) when tagging statements.
- **ESM only, single context:** no CommonJS build or `require` export condition; `@auditstream/node` is always a peer dependency of ORM adapters, never a direct dependency.
- **Runtime portability:** use `AsyncLocalStorage.run()` only (never `enterWith()`); wrap Next.js Route Handlers and Server Actions rather than `proxy`.
- **Supported ORMs:** `@prisma/client` `>=7.1.0 <8` (never peer the `prisma` CLI) and `drizzle-orm` `0.45` and `1.x`.
- **No capture logic in TypeScript:** Postgres triggers record DB changes; `audit.log()` writes app events only through `auditstream.log_event`.

## Generated files and boundaries

- **Never hand-edit:** `pnpm-lock.yaml` (regenerate with `pnpm install`), `packages/*/dist/`, API Extractor reports (regenerate via script) and Vitest snapshots (review before updating).
- **Contract boundary:** `spec/` lives in `auditstream/auditstream`; adapters never redefine capture semantics.
- **Agent limits:** take only unassigned, unblocked `agent-ready` issues, claim by assigning the human running you, edit only **In**-scope paths, and never approve, merge, push to `main`, change repo settings/secrets, or publish packages. Draft GitHub comments for the maintainer instead of posting.

## Commits and pull requests

- One issue, one branch (`<type>/<issue>-<slug>`), one worktree under `worktrees/`, one pull request; rebase on `main` daily.
- PR titles follow Conventional Commits 1.0 with JS scopes: `node`, `prisma`, `drizzle`, `docs`, `ci`, `deps`.
- Keep PRs at or under ~400 changed lines (excluding lockfiles and generated files). Add a changeset for package changes (exempt for docs and CI-only changes).
- Open PRs as drafts and mark ready only after verification passes. Fill in Summary, `Closes #N`, Spec impact (with spec version), How it was tested (commands and output; new tests shown failing first), AI disclosure and Checklist.

## Definition of done

- [ ] Every acceptance criterion in the issue is met
- [ ] New tests cover the change and pass in CI
- [ ] Docs, changelog entry or changeset, and the spec are updated where the change touches them
- [ ] No new warnings from clippy or Biome
- [ ] Reviewed, squash-merged, and the issue closed by the merge
