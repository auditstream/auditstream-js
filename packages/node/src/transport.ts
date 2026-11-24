import {
  type ActorType,
  type AuditContext,
  type AuditScope,
  AuditstreamError,
  audit,
  type CachedScopePayload,
  getCachedScopePayload,
  MAX_PAYLOAD_BYTES,
  type NestedActor,
} from "./context.js";

/**
 * Maximum character length of an unpadded base64url actor payload in a trailing SQL comment
 * (`ceil(512 * 4 / 3) = 683` per Auditstream Specification 0.1.0).
 */
export const MAX_ENCODED_COMMENT_CHARS: 683 = 683;

/**
 * Mechanism that produced a decoded actor payload (`spec/transport.md`).
 */
export type ActorSource = "set_config" | "comment" | "jwt" | "invalid";

/**
 * Result returned by {@link decodeScope} when inspecting a SQL statement's trailing comment.
 */
export interface DecodedTransport {
  /** Decoded actor object, or `null` when absent or malformed. */
  readonly actor: Record<string, unknown> | null;
  /** Decoded execution context object, or `null` when absent or malformed. */
  readonly context: Record<string, unknown> | null;
  /** Transport source (`"comment"`, `"invalid"`, or `null` when no `auditstream` tag is present). */
  readonly actorSource: "comment" | "invalid" | null;
}

const VALID_ACTOR_TYPES: ReadonlySet<string> = new Set<ActorType>([
  "user",
  "api_key",
  "ai_agent",
  "service",
  "system",
]);

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_DECODE_LUT = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
  BASE64URL_DECODE_LUT[BASE64URL_ALPHABET.codePointAt(i) ?? 0] = i;
}

const TRAILING_COMMENT_REGEX = /\/\*([^/]*)\*\/[\s;]*$/;
const AUDITSTREAM_PREFIX = "auditstream='";
const COMMA_AUDITSTREAM_PREFIX = ",auditstream='";
const TAIL_SLICE_CHARS = 4096;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Internal RFC 4648 unpadded base64url encoder shared with `query.ts` cursors.
 */
export function encodeBase64UrlUnpadded(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  let i = 0;

  while (i + 2 < len) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const chunk = (b0 << 16) | (b1 << 8) | b2;
    out +=
      BASE64URL_ALPHABET.charAt((chunk >> 18) & 0x3f) +
      BASE64URL_ALPHABET.charAt((chunk >> 12) & 0x3f) +
      BASE64URL_ALPHABET.charAt((chunk >> 6) & 0x3f) +
      BASE64URL_ALPHABET.charAt(chunk & 0x3f);
    i += 3;
  }

  const remaining = len - i;
  if (remaining === 1) {
    const b0 = bytes[i] ?? 0;
    out +=
      BASE64URL_ALPHABET.charAt((b0 >> 2) & 0x3f) + BASE64URL_ALPHABET.charAt((b0 << 4) & 0x3f);
  } else if (remaining === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const chunk = (b0 << 8) | b1;
    out +=
      BASE64URL_ALPHABET.charAt((chunk >> 10) & 0x3f) +
      BASE64URL_ALPHABET.charAt((chunk >> 4) & 0x3f) +
      BASE64URL_ALPHABET.charAt((chunk << 2) & 0x3f);
  }

  return out;
}

function decodeBase64UrlChar(encoded: string, index: number): number {
  const code = encoded.codePointAt(index) ?? 128;
  return code < 128 ? (BASE64URL_DECODE_LUT[code] ?? -1) : -1;
}

/**
 * Internal RFC 4648 unpadded base64url decoder shared with `query.ts` cursors.
 */
export function decodeBase64UrlUnpadded(
  encoded: string,
  maxLen: number = MAX_ENCODED_COMMENT_CHARS,
): Uint8Array | null {
  const len = encoded.length;
  if (len === 0 || len > maxLen || len % 4 === 1) {
    return null;
  }

  const byteLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(byteLen);
  const rem = len % 4;
  const fullEnd = len - rem;
  let outIdx = 0;

  for (let i = 0; i < fullEnd; i += 4) {
    const c0 = decodeBase64UrlChar(encoded, i);
    const c1 = decodeBase64UrlChar(encoded, i + 1);
    const c2 = decodeBase64UrlChar(encoded, i + 2);
    const c3 = decodeBase64UrlChar(encoded, i + 3);
    if ((c0 | c1 | c2 | c3) < 0) {
      return null;
    }
    out[outIdx++] = (c0 << 2) | (c1 >> 4);
    out[outIdx++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    out[outIdx++] = ((c2 & 0x03) << 6) | c3;
  }

  if (rem === 2) {
    const c0 = decodeBase64UrlChar(encoded, fullEnd);
    const c1 = decodeBase64UrlChar(encoded, fullEnd + 1);
    if ((c0 | c1) < 0) {
      return null;
    }
    out[outIdx] = (c0 << 2) | (c1 >> 4);
  } else if (rem === 3) {
    const c0 = decodeBase64UrlChar(encoded, fullEnd);
    const c1 = decodeBase64UrlChar(encoded, fullEnd + 1);
    const c2 = decodeBase64UrlChar(encoded, fullEnd + 2);
    if ((c0 | c1 | c2) < 0) {
      return null;
    }
    out[outIdx++] = (c0 << 2) | (c1 >> 4);
    out[outIdx] = ((c1 & 0x0f) << 4) | (c2 >> 2);
  }

  return out;
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  code: "INVALID_ACTOR" | "INVALID_CONTEXT",
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuditstreamError(code, `${field} must be a non-empty string`);
  }
}

/**
 * Locale-independent UTF-16 code-unit comparator matching `spec/transport.md` lexicographic
 * key ordering without depending on the host's default locale.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function canonicalizeNestedActor(raw: unknown): NestedActor {
  if (!isPlainObject(raw)) {
    throw new AuditstreamError("INVALID_ACTOR", "actor.onBehalfOf must be a JSON object");
  }
  if (typeof raw.type !== "string" || !VALID_ACTOR_TYPES.has(raw.type)) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      "actor.onBehalfOf.type must be one of user, api_key, ai_agent, service, system",
    );
  }
  assertNonEmptyString(raw.id, "actor.onBehalfOf.id", "INVALID_ACTOR");
  if ("onBehalfOf" in raw && raw.onBehalfOf !== undefined) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      "actor.onBehalfOf must not contain a nested onBehalfOf (max depth is 1)",
    );
  }
  if (raw.tenant !== undefined) {
    assertNonEmptyString(raw.tenant, "actor.onBehalfOf.tenant", "INVALID_ACTOR");
  }

  // Emit keys in strict spec/transport.md canonical order: type, id, tenant.
  const ordered: Record<string, unknown> = {
    type: raw.type,
    id: raw.id,
  };
  if (raw.tenant !== undefined) {
    ordered.tenant = raw.tenant;
  }

  // Append any additional unknown keys in lexicographic order per spec/transport.md.
  for (const key of Object.keys(raw).sort(compareCodeUnits)) {
    if (key === "type" || key === "id" || key === "tenant" || key === "onBehalfOf") {
      continue;
    }
    if (raw[key] !== undefined) {
      ordered[key] = raw[key];
    }
  }

  return ordered as unknown as NestedActor;
}

function canonicalizeContext(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new AuditstreamError("INVALID_CONTEXT", "context must be a JSON object");
  }

  // Emit keys in strict spec/transport.md canonical order: requestId, source, ip, userAgent.
  const ordered: Record<string, unknown> = {};

  if (raw.requestId !== undefined) {
    assertNonEmptyString(raw.requestId, "context.requestId", "INVALID_CONTEXT");
    ordered.requestId = raw.requestId;
  }
  if (raw.source !== undefined) {
    assertNonEmptyString(raw.source, "context.source", "INVALID_CONTEXT");
    ordered.source = raw.source;
  }
  if (raw.ip !== undefined) {
    assertNonEmptyString(raw.ip, "context.ip", "INVALID_CONTEXT");
    ordered.ip = raw.ip;
  }
  if (raw.userAgent !== undefined) {
    assertNonEmptyString(raw.userAgent, "context.userAgent", "INVALID_CONTEXT");
    ordered.userAgent = raw.userAgent;
  }

  for (const key of Object.keys(raw).sort(compareCodeUnits)) {
    if (key === "requestId" || key === "source" || key === "ip" || key === "userAgent") {
      continue;
    }
    if (raw[key] !== undefined) {
      ordered[key] = raw[key];
    }
  }

  return ordered;
}

function serializeCanonicalPayload(scope: AuditScope): { json: string; bytes: Uint8Array } {
  const rawActor = scope.actor as unknown;
  if (!isPlainObject(rawActor)) {
    throw new AuditstreamError("INVALID_ACTOR", "actor must be a JSON object");
  }
  if (typeof rawActor.type !== "string" || !VALID_ACTOR_TYPES.has(rawActor.type)) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      "actor.type must be one of user, api_key, ai_agent, service, system",
    );
  }
  assertNonEmptyString(rawActor.id, "actor.id", "INVALID_ACTOR");

  const nested =
    rawActor.onBehalfOf !== undefined ? canonicalizeNestedActor(rawActor.onBehalfOf) : undefined;

  if (rawActor.tenant !== undefined) {
    assertNonEmptyString(rawActor.tenant, "actor.tenant", "INVALID_ACTOR");
  }

  const rawContext: AuditContext | undefined = scope.context;
  const canonicalContext = rawContext !== undefined ? canonicalizeContext(rawContext) : undefined;

  // Emit keys in strict spec/transport.md canonical order: type, id, onBehalfOf, tenant, context.
  const ordered: Record<string, unknown> = {
    type: rawActor.type,
    id: rawActor.id,
  };
  if (nested !== undefined) {
    ordered.onBehalfOf = nested;
  }
  if (rawActor.tenant !== undefined) {
    ordered.tenant = rawActor.tenant;
  }
  if (canonicalContext !== undefined) {
    ordered.context = canonicalContext;
  }

  for (const key of Object.keys(rawActor).sort(compareCodeUnits)) {
    if (
      key === "type" ||
      key === "id" ||
      key === "onBehalfOf" ||
      key === "tenant" ||
      key === "context"
    ) {
      continue;
    }
    if (rawActor[key] !== undefined) {
      ordered[key] = rawActor[key];
    }
  }

  const json = JSON.stringify(ordered);
  const bytes = utf8Encoder.encode(json);
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new AuditstreamError(
      "PAYLOAD_TOO_LARGE",
      `serialized actor payload is ${bytes.byteLength} UTF-8 bytes, exceeding the ${MAX_PAYLOAD_BYTES}-byte limit`,
    );
  }

  return { json, bytes };
}

function getOrEncodeCached(cached: CachedScopePayload): string {
  if (cached.encoded === undefined) {
    cached.encoded = encodeBase64UrlUnpadded(cached.bytes);
  }
  return cached.encoded;
}

function isAsciiWhitespaceOrSemicolon(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x3b ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x09 ||
    code === 0x0c ||
    code === 0x0b
  );
}

function extractTrailingCommentBody(sql: string): string | null {
  const len = sql.length;
  const windowStart = Math.max(0, len - TAIL_SLICE_CHARS);
  let end = len - 1;

  while (end >= windowStart) {
    const code = sql.codePointAt(end) ?? 0;
    if (isAsciiWhitespaceOrSemicolon(code)) {
      end--;
      continue;
    }
    if (code > 0x7f) {
      const commentMatch = TRAILING_COMMENT_REGEX.exec(sql.slice(windowStart));
      return commentMatch?.[1] ?? null;
    }
    break;
  }

  // Need at least 4 characters inside the tail window for `/**/`.
  if (end < windowStart + 3 || sql.codePointAt(end) !== 0x2f || sql.codePointAt(end - 1) !== 0x2a) {
    return null;
  }

  const openSlash = sql.lastIndexOf("/", end - 2);
  // Require openSlash <= end - 3 so `/*` and `*/` cannot overlap on a single `*` (for example `/*/`).
  if (openSlash < windowStart || openSlash > end - 3 || sql.codePointAt(openSlash + 1) !== 0x2a) {
    return null;
  }

  return sql.slice(openSlash + 2, end - 1);
}

function extractAuditstreamTagValue(body: string): string | null {
  let valueStart: number;
  if (body.startsWith(AUDITSTREAM_PREFIX)) {
    valueStart = AUDITSTREAM_PREFIX.length;
  } else {
    const keyIdx = body.indexOf(COMMA_AUDITSTREAM_PREFIX);
    if (keyIdx === -1) {
      return null;
    }
    valueStart = keyIdx + COMMA_AUDITSTREAM_PREFIX.length;
  }

  const quoteIdx = body.indexOf("'", valueStart);
  if (quoteIdx === -1) {
    return null;
  }
  return body.slice(valueStart, quoteIdx);
}

/**
 * Validates `scope` against Auditstream Specification 0.1.0, serializes it into canonical
 * compact UTF-8 JSON (key order `type`, `id`, `onBehalfOf`, `tenant`, `context`), and
 * returns the RFC 4648 unpadded base64url representation suitable for `/*auditstream='...'*\/`.
 *
 * Uses `TextEncoder` and a self-contained base64url encoder with no `Buffer` dependency so
 * it runs cleanly on Node.js, Bun, Deno, and Cloudflare Workers (`nodejs_als` only).
 *
 * @throws {@link AuditstreamError} if the actor/context is invalid or exceeds 512 UTF-8 bytes.
 */
export function encodeScope(scope: AuditScope): string {
  const cached = getCachedScopePayload(scope);
  if (cached !== undefined) {
    return getOrEncodeCached(cached);
  }
  const { bytes } = serializeCanonicalPayload(scope);
  return encodeBase64UrlUnpadded(bytes);
}

/**
 * Validates `scope` against Auditstream Specification 0.1.0 and returns the canonical
 * compact UTF-8 JSON string for `SELECT set_config('auditstream.actor', $1, true)`.
 *
 * @throws {@link AuditstreamError} if the actor/context is invalid or exceeds 512 UTF-8 bytes.
 */
export function setConfigValue(scope: AuditScope): string {
  const cached = getCachedScopePayload(scope);
  if (cached !== undefined) {
    return cached.json;
  }
  const { json } = serializeCanonicalPayload(scope);
  return json;
}

/**
 * Returns `true` if `sql` already ends with a trailing comment containing an `auditstream`
 * sqlcommenter key (with optional trailing ASCII whitespace or semicolons).
 */
export function isTagged(sql: string): boolean {
  const body = extractTrailingCommentBody(sql);
  if (body === null) {
    return false;
  }
  return extractAuditstreamTagValue(body) !== null;
}

/**
 * Appends ` /*auditstream='<base64url>'*\/` to the end of `sql` for the active or supplied
 * {@link AuditScope}.
 *
 * - Defaults `scope` to `audit.current()`.
 * - Returns `sql` unchanged when no scope is active or when `sql` is already tagged.
 * - Never tags a statement twice; appends after any existing SQL comments.
 * - Throws {@link AuditstreamError} before building any SQL text when the scope is invalid
 *   or exceeds 512 UTF-8 bytes.
 */
export function tagSql(sql: string, scope: AuditScope | undefined = audit.current()): string {
  if (scope === undefined) {
    return sql;
  }
  if (isTagged(sql)) {
    return sql;
  }
  const cached = getCachedScopePayload(scope);
  if (cached !== undefined) {
    if (cached.commentSuffix === undefined) {
      cached.commentSuffix = ` /*auditstream='${getOrEncodeCached(cached)}'*/`;
    }
    return `${sql}${cached.commentSuffix}`;
  }
  const encoded = encodeScope(scope);
  return `${sql} /*auditstream='${encoded}'*/`;
}

/**
 * Decodes a trailing `/*auditstream='...'*\/` SQL comment from `sql` following the exact
 * extraction and validation rules in `spec/transport.md`.
 *
 * - Returns `{ actor: null, context: null, actorSource: null }` when no trailing comment
 *   or no `auditstream` key is present.
 * - Returns `{ actor: null, context: null, actorSource: "invalid" }` when an `auditstream`
 *   key is present but malformed, oversized (over 512 UTF-8 bytes or 683 chars), padded,
 *   invalid UTF-8, non-JSON, or missing non-empty string `type`/`id`.
 * - Never throws on malformed input.
 */
export function decodeScope(sql: string): DecodedTransport {
  const body = extractTrailingCommentBody(sql);
  if (body === null) {
    return { actor: null, context: null, actorSource: null };
  }

  const rawValue = extractAuditstreamTagValue(body);
  if (rawValue === null) {
    return { actor: null, context: null, actorSource: null };
  }

  const bytes = decodeBase64UrlUnpadded(rawValue);
  if (bytes === null || bytes.byteLength > MAX_PAYLOAD_BYTES) {
    return { actor: null, context: null, actorSource: "invalid" };
  }

  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch {
    return { actor: null, context: null, actorSource: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { actor: null, context: null, actorSource: "invalid" };
  }

  if (
    !isPlainObject(parsed) ||
    typeof parsed.type !== "string" ||
    parsed.type.length === 0 ||
    typeof parsed.id !== "string" ||
    parsed.id.length === 0
  ) {
    return { actor: null, context: null, actorSource: "invalid" };
  }

  let context: Record<string, unknown> | null = null;
  const actor: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "context") {
      if (isPlainObject(value)) {
        context = value;
      }
      continue;
    }
    actor[key] = value;
  }

  return {
    actor,
    context,
    actorSource: "comment",
  };
}
