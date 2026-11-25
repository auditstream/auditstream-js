import type { Actor, AuditContext } from "@auditstream/node";

/**
 * Resolves the demo actor from the `x-demo-user` (and optional `x-demo-tenant`) HTTP headers.
 *
 * **Demo only:** never trust client-supplied headers in production. Real apps must
 * resolve the actor and tenant from a verified session or JWT. In Next.js 16, `proxy`
 * cannot hold an `AsyncLocalStorage` scope across Route Handlers or Server Actions; if
 * `proxy` forwards an identity header, it must overwrite or strip that header on every request.
 *
 * Actors carry IDs only (no names, emails, or IP addresses).
 */
export function resolveDemoActor(headers: Headers): Actor | undefined {
  const userId = headers.get("x-demo-user")?.trim();
  if (!userId) {
    return undefined;
  }
  const tenant = resolveDemoTenant(headers);
  return tenant ? { type: "user", id: userId, tenant } : { type: "user", id: userId };
}

/**
 * Resolves an optional demo tenant identifier from the `x-demo-tenant` HTTP header.
 *
 * **Demo only:** never trust client-supplied headers or URL query parameters for tenant
 * isolation in production. Real apps must derive the tenant strictly from a verified
 * session or JWT and enforce authorization server-side.
 */
export function resolveDemoTenant(headers: Headers): string | undefined {
  const tenant = headers.get("x-demo-tenant")?.trim();
  return tenant && tenant.length > 0 ? tenant : undefined;
}

/**
 * Resolves optional execution context from request headers.
 */
export function resolveAuditContext(headers: Headers, source: string): AuditContext {
  const requestId = headers.get("x-request-id");
  return requestId && /^[A-Za-z0-9._-]{1,64}$/.test(requestId) ? { requestId, source } : { source };
}
