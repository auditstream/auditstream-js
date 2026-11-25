# @auditstream/prisma

## 0.2.1

### Patch Changes

- 4893f97: Fix `@auditstream/drizzle` README imports (`drizzle-orm` instead of internal `drizzle-orm-v1`), polish all published package READMEs with idiomatic examples and verified badges, and add `homepage` metadata pointing to `https://auditstream.dev/docs/typescript/`.
- 0bee515: Update package `homepage` URLs to point directly to the `/docs/typescript/` documentation routes.

## 0.2.0

### Minor Changes

- 22e355e: Implement the `auditstream()` Prisma 7 SQL comments plugin with local structural types, end-to-end integration tests across `PrismaPg` (and optional `NEON_TEST_URL` cells for `PrismaNeon` and `PrismaNeonHttp`), and JC2 rules in `packages/prisma/AGENTS.md`.
- b3f019d: Add the `auditTransaction()` transaction-local `set_config` fallback (`SELECT set_config('auditstream.actor', $1, true)` via `setConfigValue()`) for Prisma Accelerate and finalize `@auditstream/prisma` TSDoc and API report.
