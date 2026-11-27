---
"@auditstream/node": patch
---

Parameterize `HonoAuditOptions<E extends Env = any>` and `auditstream<E extends Env = any>()` in `@auditstream/node/hono` over Hono's `Env` type so typed `Hono<AppEnv>` apps can pass `auditstream<AppEnv>({ ... })`, annotate `(c: Context<AppEnv>)`, or use `createFactory<AppEnv>().createMiddleware(auditstream({ ... }))` with full `Variables` and `Bindings` type safety while preserving backwards compatibility and downstream route-param inference.
