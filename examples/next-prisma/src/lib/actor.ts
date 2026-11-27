import type { Actor, AuditContext } from "@auditstream/node";

/**
 * Maximum serialized JSON UTF-8 byte length (excluding surrounding quotes) accepted for each
 * demo identity header (`x-demo-user`, `x-demo-tenant`). Keeps worst-case combined actor +
 * context payloads well under Auditstream's 512-byte transport limit even with JSON escaping
 * (`\"`, `\\`) or multi-byte UTF-8 characters.
 */
export const MAX_DEMO_HEADER_BYTES = 128;

const utf8Encoder = new TextEncoder();

function isWellFormedString(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function readBoundedDemoHeader(headers: Headers, name: string): string | undefined {
  const raw = headers.get(name)?.trim();
  if (!raw || !isWellFormedString(raw) || /\p{Cc}/u.test(raw)) {
    return undefined;
  }
  if (utf8Encoder.encode(JSON.stringify(raw)).byteLength - 2 > MAX_DEMO_HEADER_BYTES) {
    return undefined;
  }
  return raw;
}

/**
 * Resolves the demo actor from the `x-demo-user` (and optional `x-demo-tenant`) HTTP headers.
 *
 * **Demo only:** never trust client-supplied headers in production. Real apps must
 * resolve the actor and tenant from a verified session or JWT. In Next.js 16, `proxy`
 * cannot hold an `AsyncLocalStorage` scope across Route Handlers or Server Actions; if
 * `proxy` forwards an identity header, it must overwrite or strip that header on every request.
 *
 * Actors carry IDs only (no names, emails, or IP addresses). Values exceeding
 * {@link MAX_DEMO_HEADER_BYTES} serialized JSON UTF-8 bytes or containing control characters
 * or unpaired surrogates are ignored.
 */
export function resolveDemoActor(headers: Headers): Actor | undefined {
  const userId = readBoundedDemoHeader(headers, "x-demo-user");
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
 * session or JWT and enforce authorization server-side. Values exceeding
 * {@link MAX_DEMO_HEADER_BYTES} serialized JSON UTF-8 bytes or containing control characters
 * or unpaired surrogates are ignored.
 */
export function resolveDemoTenant(headers: Headers): string | undefined {
  return readBoundedDemoHeader(headers, "x-demo-tenant");
}

/**
 * Resolves optional execution context from request headers.
 */
export function resolveAuditContext(headers: Headers, source: string): AuditContext {
  const requestId = headers.get("x-request-id");
  return requestId && /^[A-Za-z0-9._-]{1,64}$/.test(requestId) ? { requestId, source } : { source };
}
