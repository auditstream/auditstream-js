import type { Actor, AuditContext } from "@auditstream/node";

/**
 * Resolves the demo actor from the `x-demo-user` HTTP header.
 *
 * **Demo only:** never trust a client-supplied header in production. Real apps must
 * resolve the actor from a verified session or JWT. In Next.js 16, `proxy` cannot hold
 * an `AsyncLocalStorage` scope across Route Handlers or Server Actions; if `proxy`
 * forwards an identity header, it must overwrite or strip that header on every request.
 *
 * Actors carry IDs only (no names, emails, or IP addresses).
 */
export function resolveDemoActor(headers: Headers): Actor | undefined {
  const userId = headers.get("x-demo-user")?.trim();
  if (!userId) {
    return undefined;
  }
  return { type: "user", id: userId };
}

/**
 * Resolves optional execution context from request headers.
 */
export function resolveAuditContext(headers: Headers, source: string): AuditContext {
  const requestId = headers.get("x-request-id")?.trim();
  return requestId ? { requestId, source } : { source };
}
