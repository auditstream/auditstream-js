---
"@auditstream/node": patch
---

Parameterize `@auditstream/node/hono` (`HonoAuditOptions<E extends Env = any>`, `auditstream<E extends Env = any>()`) and `@auditstream/node/express` (`ExpressAuditOptions<TRequest extends Request = Request, TLocals extends Record<string, any> = Record<string, unknown>>`, `auditstream<TRequest, TLocals>()`) so callers get strongly typed `Context<AppEnv>`, `AuthedRequest`, and `res.locals` inside `actor` and `context` resolvers without inline `as` assertions, while remaining 100% backwards compatible. Guard `@auditstream/node/express` against calling `next()` when a resolver already sent or ended `res`.
