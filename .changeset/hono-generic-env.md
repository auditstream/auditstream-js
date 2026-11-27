---
"@auditstream/node": patch
---

Parameterize `@auditstream/node/hono` (`HonoAuditOptions<E extends Env = any>`, `auditstream<E extends Env = any>()`) and `@auditstream/node/express` (`ExpressAuditOptions<TRequest extends Request = Request>`, `auditstream<TRequest extends Request = Request>()`) so callers get strongly typed `Context<AppEnv>` and `AuthedRequest` inside `actor` and `context` resolvers (via explicit type arguments, parameter annotation, or Hono `createFactory<AppEnv>().createMiddleware(...)`) without inline `as` assertions, while remaining 100% backwards compatible.
