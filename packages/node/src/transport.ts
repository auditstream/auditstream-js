import {
  type ActorType,
  type AuditScope,
  AuditstreamError,
  audit,
  type CachedScopePayload,
  defineOwnDataProperty,
  getCachedScopePayload,
  getOwnValue,
  hasForbiddenPrototypeKey,
  isPlainObject,
  MAX_PAYLOAD_BYTES,
  type NestedActor,
  readOwnPropertySafe,
  readValidatedActorCore,
  readValidatedKnownContext,
  serializeScopeParts,
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
const KNOWN_CONTEXT_KEYS: readonly string[] = ["requestId", "source", "ip", "userAgent"];

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64URL_DECODE_LUT = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
  BASE64URL_DECODE_LUT[BASE64URL_ALPHABET.codePointAt(i) ?? 0] = i;
}

const TAIL_SLICE_CHARS = 4096;

// Preserve leading UTF-8 BOM (0xEF 0xBB 0xBF) so JSON.parse() rejects it, matching PostgreSQL
// convert_from(..., 'UTF8')::jsonb (which does not strip BOM and yields actor_source = 'invalid').
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidOptionalNonEmptyString(obj: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(obj, key) || isNonEmptyString(obj[key]);
}

function isValidNestedActorObject(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const type = getOwnValue(value, "type");
  const id = getOwnValue(value, "id");
  return (
    typeof type === "string" &&
    VALID_ACTOR_TYPES.has(type) &&
    isNonEmptyString(id) &&
    !Object.hasOwn(value, "onBehalfOf") &&
    isValidOptionalNonEmptyString(value, "tenant")
  );
}

/** Internal Spec 0.1.0 actor payload validator shared with `history.ts`. */
export function isValidActorObject(value: unknown): boolean {
  if (!isPlainObject(value) || hasForbiddenPrototypeKey(value)) {
    return false;
  }
  const type = getOwnValue(value, "type");
  const id = getOwnValue(value, "id");
  if (
    typeof type !== "string" ||
    !VALID_ACTOR_TYPES.has(type) ||
    !isNonEmptyString(id) ||
    !isValidOptionalNonEmptyString(value, "tenant")
  ) {
    return false;
  }
  if (Object.hasOwn(value, "onBehalfOf") && !isValidNestedActorObject(value.onBehalfOf)) {
    return false;
  }
  return true;
}

/** Internal Spec 0.1.0 context payload validator shared with `history.ts`. */
export function isValidContextObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || hasForbiddenPrototypeKey(value)) {
    return false;
  }
  for (const key of KNOWN_CONTEXT_KEYS) {
    if (!isValidOptionalNonEmptyString(value, key)) {
      return false;
    }
  }
  return true;
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

const KNOWN_NESTED_ACTOR_KEYS: ReadonlySet<string> = new Set([
  "type",
  "id",
  "tenant",
  "onBehalfOf",
]);
const KNOWN_CONTEXT_KEY_SET: ReadonlySet<string> = new Set(KNOWN_CONTEXT_KEYS);
const KNOWN_ACTOR_KEYS: ReadonlySet<string> = new Set([
  "type",
  "id",
  "onBehalfOf",
  "tenant",
  "context",
]);

function copyCanonicalExtensionKeys(
  raw: Record<string, unknown>,
  ordered: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  errorCode: "INVALID_ACTOR" | "INVALID_CONTEXT",
): boolean {
  const label = errorCode === "INVALID_CONTEXT" ? "context" : "actor";
  let sortedKeys: string[];
  try {
    sortedKeys = Object.keys(raw).sort(compareCodeUnits);
  } catch {
    throw new AuditstreamError(errorCode, `${label} is not JSON-serializable`);
  }

  let copiedAny = false;
  for (const key of sortedKeys) {
    if (knownKeys.has(key)) {
      continue;
    }
    const value = readOwnPropertySafe(raw, key, `${label}.${key}`, errorCode);
    if (value === undefined) {
      continue;
    }
    if (key === "toJSON" && typeof value === "function") {
      throw new AuditstreamError(errorCode, `${label} must not define a toJSON method`);
    }
    defineOwnDataProperty(ordered, key, value);
    copiedAny = true;
  }
  return copiedAny;
}

function canonicalizeNestedActor(raw: unknown): NestedActor {
  const { type, id, tenant } = readValidatedActorCore(raw, "actor.onBehalfOf", true);
  // Emit keys in strict spec/transport.md canonical order: type, id, tenant.
  const ordered: Record<string, unknown> = { type, id };
  if (tenant !== undefined) {
    ordered.tenant = tenant;
  }
  copyCanonicalExtensionKeys(
    raw as Record<string, unknown>,
    ordered,
    KNOWN_NESTED_ACTOR_KEYS,
    "INVALID_ACTOR",
  );
  return ordered as unknown as NestedActor;
}

function canonicalizeContext(raw: unknown): Record<string, unknown> {
  // Emit keys in strict spec/transport.md canonical order: requestId, source, ip, userAgent.
  const ordered = readValidatedKnownContext(raw);
  copyCanonicalExtensionKeys(
    raw as Record<string, unknown>,
    ordered,
    KNOWN_CONTEXT_KEY_SET,
    "INVALID_CONTEXT",
  );
  return ordered;
}

function serializeCanonicalPayload(scope: AuditScope): { json: string; bytes: Uint8Array } {
  if (typeof scope !== "object" || scope === null) {
    throw new AuditstreamError("INVALID_ACTOR", "scope must be an object");
  }
  let rawActor: unknown;
  try {
    rawActor = scope.actor;
  } catch {
    throw new AuditstreamError("INVALID_ACTOR", "actor is not readable");
  }
  let rawContext: unknown;
  try {
    rawContext = scope.context;
  } catch {
    throw new AuditstreamError("INVALID_CONTEXT", "context is not readable");
  }

  const { type, id, tenant } = readValidatedActorCore(rawActor, "actor", false);
  const rawOnBehalfOf = readOwnPropertySafe(
    rawActor as Record<string, unknown>,
    "onBehalfOf",
    "actor.onBehalfOf",
    "INVALID_ACTOR",
  );
  const nested = rawOnBehalfOf === undefined ? undefined : canonicalizeNestedActor(rawOnBehalfOf);
  const canonicalContext = rawContext === undefined ? undefined : canonicalizeContext(rawContext);

  // Emit keys in strict spec/transport.md canonical order: type, id, onBehalfOf, tenant, context.
  const knownActor: Record<string, unknown> = { type, id };
  if (nested !== undefined) {
    knownActor.onBehalfOf = nested;
  }
  if (tenant !== undefined) {
    knownActor.tenant = tenant;
  }

  const extraActor: Record<string, unknown> = {};
  const hasExtras = copyCanonicalExtensionKeys(
    rawActor as Record<string, unknown>,
    extraActor,
    KNOWN_ACTOR_KEYS,
    "INVALID_ACTOR",
  );

  return serializeScopeParts(knownActor, canonicalContext, hasExtras ? extraActor : undefined);
}

function getOrEncodeCached(cached: CachedScopePayload): string {
  if (cached.encoded === undefined) {
    cached.encoded = encodeBase64UrlUnpadded(cached.bytes);
  }
  return cached.encoded;
}

interface SqlTailInfo {
  readonly endsInLineComment: boolean;
  readonly trailingBlockCommentBody: string | null;
}

type ParsedCommentTag =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "found"; readonly value: string };

const PG_NUMERIC_MAX_DSCALE = 16_383;
const PG_NUMERIC_MAX_MSD_POS = 131_071; // floor(131071 / 4) === NUMERIC_WEIGHT_MAX (32767)
const PG_NUMERIC_EXP_LIMIT = 1_073_741_823; // INT_MAX / 2 in PostgreSQL numeric.c

function codeAt(text: string, index: number): number {
  return text.codePointAt(index) ?? -1;
}

/**
 * Matches PostgreSQL `scan.l` `space` (`[ \t\n\r\f\v]`) and `resolve_actor()`'s
 * `rtrim(..., E' \t\n\r\f\v;')`. Non-ASCII whitespace (such as `\u00A0`) is lexed as an
 * identifier character by PostgreSQL, not whitespace.
 */
function isSqlWhitespaceCode(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x09 ||
    code === 0x0c ||
    code === 0x0b
  );
}

function isNewlineCode(code: number): boolean {
  return code === 0x0a || code === 0x0d;
}

function isIdentStartCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code >= 0x80
  );
}

function isIdentContCode(code: number): boolean {
  return isIdentStartCode(code) || (code >= 0x30 && code <= 0x39) || code === 0x24;
}

function isDollarTagContCode(code: number): boolean {
  return isIdentStartCode(code) || (code >= 0x30 && code <= 0x39);
}

function isSqlcommenterKeyChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x25
  );
}

function isLineCommentStart(sql: string, index: number): boolean {
  return codeAt(sql, index) === 0x2d && codeAt(sql, index + 1) === 0x2d;
}

function isBlockCommentStart(sql: string, index: number): boolean {
  return codeAt(sql, index) === 0x2f && codeAt(sql, index + 1) === 0x2a;
}

function matchDollarQuoteTag(sql: string, start: number): string | null {
  if (start > 0 && isIdentContCode(codeAt(sql, start - 1))) {
    return null;
  }
  const next = codeAt(sql, start + 1);
  if (next === 0x24) {
    return "$$";
  }
  if (!isIdentStartCode(next)) {
    return null;
  }
  let j = start + 2;
  while (j < sql.length && isDollarTagContCode(codeAt(sql, j))) {
    j += 1;
  }
  return codeAt(sql, j) === 0x24 ? sql.slice(start, j + 1) : null;
}

function skipQuotedToken(sql: string, start: number, quoteCode: number): number {
  const len = sql.length;
  let i = start + 1;
  while (i < len) {
    if (codeAt(sql, i) !== quoteCode) {
      i += 1;
      continue;
    }
    if (codeAt(sql, i + 1) === quoteCode) {
      i += 2;
    } else {
      return i + 1;
    }
  }
  return len;
}

function skipLineComment(
  sql: string,
  start: number,
): { readonly nextIndex: number; readonly terminated: boolean } {
  const len = sql.length;
  let i = start + 2;
  while (i < len) {
    const c = codeAt(sql, i);
    i += 1;
    if (isNewlineCode(c)) {
      return { nextIndex: i, terminated: true };
    }
  }
  return { nextIndex: len, terminated: false };
}

/**
 * Matches PostgreSQL `scan.l` `<xe>{quotecontinue}` (`{whitespace_with_newline}'`) so
 * multi-line `E'...'` continuations keep backslash escaping active across chunks.
 */
function matchQuoteContinue(sql: string, afterQuote: number): number {
  const len = sql.length;
  let j = afterQuote;
  let seenNewline = false;

  while (j < len) {
    const c = codeAt(sql, j);
    if (isSqlWhitespaceCode(c)) {
      seenNewline ||= isNewlineCode(c);
      j += 1;
    } else if (isLineCommentStart(sql, j)) {
      const line = skipLineComment(sql, j);
      if (!line.terminated) {
        return -1;
      }
      seenNewline = true;
      j = line.nextIndex;
    } else {
      return c === 0x27 && seenNewline ? j + 1 : -1;
    }
  }
  return -1;
}

function skipEscapeString(sql: string, start: number): number {
  const len = sql.length;
  let i = start + 2;
  while (i < len) {
    const c = codeAt(sql, i);
    if (c === 0x5c) {
      i += 2;
    } else if (c !== 0x27) {
      i += 1;
    } else if (codeAt(sql, i + 1) === 0x27) {
      i += 2;
    } else {
      const cont = matchQuoteContinue(sql, i + 1);
      if (cont === -1) {
        return i + 1;
      }
      i = cont;
    }
  }
  return len;
}

function scanBlockComment(
  sql: string,
  start: number,
): { readonly nextIndex: number; readonly closed: boolean; readonly hasSlashInBody: boolean } {
  const len = sql.length;
  let i = start + 2;
  let depth = 1;
  let hasSlashInBody = false;

  while (i < len && depth > 0) {
    const c = codeAt(sql, i);
    const next = codeAt(sql, i + 1);
    if (c === 0x2f && next === 0x2a) {
      depth += 1;
      hasSlashInBody = true;
      i += 2;
    } else if (c === 0x2a && next === 0x2f) {
      depth -= 1;
      hasSlashInBody ||= depth > 0;
      i += 2;
    } else {
      hasSlashInBody ||= c === 0x2f;
      i += 1;
    }
  }

  return { nextIndex: i, closed: depth === 0, hasSlashInBody };
}

function isEscapeStringStart(sql: string, index: number, ch: number): boolean {
  return (
    (ch === 0x45 || ch === 0x65) &&
    codeAt(sql, index + 1) === 0x27 &&
    (index === 0 || !isIdentContCode(codeAt(sql, index - 1)))
  );
}

function skipNonCommentToken(sql: string, index: number, ch: number): number {
  if (isEscapeStringStart(sql, index, ch)) {
    return skipEscapeString(sql, index);
  }
  if (ch === 0x27 || ch === 0x22) {
    return skipQuotedToken(sql, index, ch);
  }
  if (ch === 0x24) {
    const tag = matchDollarQuoteTag(sql, index);
    if (tag !== null) {
      const closeIdx = sql.indexOf(tag, index + tag.length);
      return closeIdx === -1 ? sql.length : closeIdx + tag.length;
    }
  }
  return index + 1;
}

/**
 * Matches PostgreSQL `pg_catalog.right(current_query(), 4096)` (Unicode code points).
 */
function isWithinTailWindow(sql: string, startIndex: number): boolean {
  const codeUnits = sql.length - startIndex;
  if (codeUnits <= TAIL_SLICE_CHARS) {
    return true;
  }
  if (codeUnits > TAIL_SLICE_CHARS * 2) {
    return false;
  }
  let codePoints = 0;
  let i = startIndex;
  while (i < sql.length) {
    codePoints += 1;
    if (codePoints > TAIL_SLICE_CHARS) {
      return false;
    }
    i += codeAt(sql, i) > 0xffff ? 2 : 1;
  }
  return true;
}

/**
 * Single-pass PostgreSQL lexical scanner determining whether `sql` ends inside an unterminated
 * `--` line comment and extracting the final trailing `/*...*\/` block comment (if within the
 * 4,096-code-point tail window and containing no `/`, outside strings, quotes, and `--` comments).
 */
function scanSqlTail(sql: string): SqlTailInfo {
  const len = sql.length;
  let lastCommentStart = -1;
  let lastCommentEnd = -1;
  let lastCommentValid = false;

  let i = 0;
  while (i < len) {
    const ch = codeAt(sql, i);
    if (ch === 0x3b || isSqlWhitespaceCode(ch)) {
      i += 1;
    } else if (isLineCommentStart(sql, i)) {
      lastCommentValid = false;
      const lineComment = skipLineComment(sql, i);
      if (!lineComment.terminated) {
        return { endsInLineComment: true, trailingBlockCommentBody: null };
      }
      i = lineComment.nextIndex;
    } else if (isBlockCommentStart(sql, i)) {
      const block = scanBlockComment(sql, i);
      lastCommentStart = i;
      lastCommentEnd = block.nextIndex;
      lastCommentValid = block.closed && !block.hasSlashInBody;
      i = block.nextIndex;
    } else {
      lastCommentValid = false;
      i = skipNonCommentToken(sql, i, ch);
    }
  }

  const trailingBlockCommentBody =
    lastCommentValid && isWithinTailWindow(sql, lastCommentStart)
      ? sql.slice(lastCommentStart + 2, lastCommentEnd - 2)
      : null;
  return { endsInLineComment: false, trailingBlockCommentBody };
}

function endsWithBlockCommentClose(sql: string): boolean {
  let end = sql.length - 1;
  while (end >= 0) {
    const code = codeAt(sql, end);
    if (code === 0x3b || isSqlWhitespaceCode(code)) {
      end -= 1;
      continue;
    }
    break;
  }
  return end >= 3 && codeAt(sql, end) === 0x2f && codeAt(sql, end - 1) === 0x2a;
}

function sqlEndsInLineComment(sql: string): boolean {
  const lastBreak = Math.max(sql.lastIndexOf("\n"), sql.lastIndexOf("\r"));
  if (sql.indexOf("--", lastBreak + 1) === -1) {
    return false;
  }
  return scanSqlTail(sql).endsInLineComment;
}

function extractTrailingCommentBody(sql: string): string | null {
  if (!endsWithBlockCommentClose(sql)) {
    return null;
  }
  return scanSqlTail(sql).trailingBlockCommentBody;
}

function readSqlcommenterValue(
  body: string,
  start: number,
  allowBackslashEscapes: boolean,
): { readonly value: string; readonly nextIndex: number } | null {
  const len = body.length;
  let i = start;
  while (i < len) {
    const c = codeAt(body, i);
    if (c === 0x2f) {
      return null;
    }
    if (allowBackslashEscapes && c === 0x5c) {
      const next = codeAt(body, i + 1);
      if (next === 0x27 || next === 0x5c) {
        i += 2;
        continue;
      }
    }
    if (c === 0x27) {
      return { value: body.slice(start, i), nextIndex: i + 1 };
    }
    i += 1;
  }
  return null;
}

function readSqlcommenterPair(
  body: string,
  start: number,
  allowOtherBackslashEscapes: boolean,
): { readonly key: string; readonly value: string; readonly nextIndex: number } | null {
  let i = start;
  while (i < body.length && isSqlcommenterKeyChar(codeAt(body, i))) {
    i += 1;
  }
  if (i === start || codeAt(body, i) !== 0x3d || codeAt(body, i + 1) !== 0x27) {
    return null;
  }
  const key = body.slice(start, i);
  const parsedVal = readSqlcommenterValue(
    body,
    i + 2,
    allowOtherBackslashEscapes && key !== "auditstream",
  );
  if (parsedVal === null) {
    return null;
  }
  return { key, value: parsedVal.value, nextIndex: parsedVal.nextIndex };
}

function advancePastPairSeparator(body: string, index: number): number {
  if (index === body.length) {
    return index;
  }
  return codeAt(body, index) === 0x2c && index + 1 < body.length ? index + 1 : -1;
}

function hasEarlierAuditstreamCollision(body: string, foundStart: number): boolean {
  return foundStart > 0 && body.indexOf(",auditstream='") !== foundStart - 1;
}

function parseCommentPairs(body: string, allowOtherBackslashEscapes: boolean): ParsedCommentTag {
  let i = 0;
  let foundValue: string | null = null;
  let foundStart = -1;
  let duplicate = false;

  while (i < body.length) {
    const pairStart = i;
    const pair = readSqlcommenterPair(body, pairStart, allowOtherBackslashEscapes);
    if (pair === null) {
      return { kind: "absent" };
    }
    if (pair.key === "auditstream") {
      duplicate ||= foundValue !== null;
      if (foundValue === null) {
        foundValue = pair.value;
        foundStart = pairStart;
      }
    }
    i = advancePastPairSeparator(body, pair.nextIndex);
    if (i < 0) {
      return { kind: "absent" };
    }
  }

  if (foundValue === null) {
    return { kind: "absent" };
  }
  return duplicate || hasEarlierAuditstreamCollision(body, foundStart)
    ? { kind: "invalid" }
    : { kind: "found", value: foundValue };
}

function parseAuditstreamFromCommentBody(body: string): ParsedCommentTag {
  if (body.length === 0) {
    return { kind: "absent" };
  }
  // Prefer strict unescaped ABNF (matching spec/transport.md and PG resolve_actor()),
  // falling back to Drizzle/Google sqlcommenter `\'` escaping only when strict parsing fails.
  const strict = parseCommentPairs(body, false);
  if (strict.kind !== "absent" || !body.includes("\\'")) {
    return strict;
  }
  return parseCommentPairs(body, true);
}

function parseHexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10;
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10;
  }
  return -1;
}

function parseHex4(raw: string, start: number): number {
  if (start + 4 > raw.length) {
    return -1;
  }
  const d0 = parseHexDigit(codeAt(raw, start));
  const d1 = parseHexDigit(codeAt(raw, start + 1));
  const d2 = parseHexDigit(codeAt(raw, start + 2));
  const d3 = parseHexDigit(codeAt(raw, start + 3));
  if ((d0 | d1 | d2 | d3) < 0) {
    return -1;
  }
  return (d0 << 12) | (d1 << 8) | (d2 << 4) | d3;
}

function isFollowedByLowSurrogateEscape(raw: string, nextIndex: number): boolean {
  if (codeAt(raw, nextIndex) !== 0x5c || codeAt(raw, nextIndex + 1) !== 0x75) {
    return false;
  }
  const low = parseHex4(raw, nextIndex + 2);
  return low >= 0xdc00 && low <= 0xdfff;
}

function classifyJsonEscape(raw: string, backslashIndex: number): number {
  if (codeAt(raw, backslashIndex + 1) !== 0x75) {
    return 2;
  }
  const code = parseHex4(raw, backslashIndex + 2);
  if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) {
    return -1;
  }
  if (code >= 0xd800 && code <= 0xdbff) {
    return isFollowedByLowSurrogateEscape(raw, backslashIndex + 6) ? 12 : -1;
  }
  return 6;
}

/**
 * Scans valid raw JSON text for `\u0000` (NUL) or unpaired UTF-16 surrogate escapes inside any
 * string literal (including overwritten duplicate object keys dropped by `JSON.parse()`).
 */
function rawJsonHasInvalidEscape(raw: string): boolean {
  if (!raw.includes("\\u")) {
    return false;
  }
  const len = raw.length;
  let i = 0;
  let inString = false;

  while (i < len) {
    const ch = codeAt(raw, i);
    if (ch === 0x22) {
      inString = !inString;
      i += 1;
    } else if (inString && ch === 0x5c) {
      const advance = classifyJsonEscape(raw, i);
      if (advance < 0) {
        return true;
      }
      i += advance;
    } else {
      i += 1;
    }
  }

  return false;
}

function isJsonNumberStartCode(code: number): boolean {
  return code === 0x2d || (code >= 0x30 && code <= 0x39);
}

function isJsonNumberContCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2e ||
    code === 0x65 ||
    code === 0x45 ||
    code === 0x2b ||
    code === 0x2d
  );
}

function findMostSignificantDigitPos(intPart: string, fracPart: string): number | null {
  for (let i = 0; i < intPart.length; i++) {
    if (codeAt(intPart, i) !== 0x30) {
      return intPart.length - 1 - i;
    }
  }
  for (let i = 0; i < fracPart.length; i++) {
    if (codeAt(fracPart, i) !== 0x30) {
      return -(i + 1);
    }
  }
  return null;
}

function isPgNumericOverflowToken(token: string): boolean {
  let eIdx = token.indexOf("e");
  if (eIdx === -1) {
    eIdx = token.indexOf("E");
  }
  if (eIdx === -1) {
    return false;
  }
  const expVal = Number(token.slice(eIdx + 1));
  if (!Number.isSafeInteger(expVal) || Math.abs(expVal) >= PG_NUMERIC_EXP_LIMIT) {
    return true;
  }
  const mantissaStart = codeAt(token, 0) === 0x2d ? 1 : 0;
  const mantissa = token.slice(mantissaStart, eIdx);
  const dotIdx = mantissa.indexOf(".");
  const intPart = dotIdx === -1 ? mantissa : mantissa.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? "" : mantissa.slice(dotIdx + 1);

  if (Math.max(0, fracPart.length - expVal) > PG_NUMERIC_MAX_DSCALE) {
    return true;
  }
  const msdPos = findMostSignificantDigitPos(intPart, fracPart);
  return msdPos !== null && msdPos + expVal > PG_NUMERIC_MAX_MSD_POS;
}

function skipJsonString(raw: string, quoteIndex: number): number {
  let i = quoteIndex + 1;
  while (i < raw.length) {
    const c = codeAt(raw, i);
    if (c === 0x5c) {
      i += 2;
    } else if (c === 0x22) {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return raw.length;
}

function readJsonNumberEnd(raw: string, start: number): number {
  let i = start + 1;
  while (i < raw.length && isJsonNumberContCode(codeAt(raw, i))) {
    i += 1;
  }
  return i;
}

/**
 * Scans valid raw JSON text (including overwritten duplicate keys) for numeric tokens that
 * overflow PostgreSQL's `jsonb` / `numeric` limits (`NUMERIC_WEIGHT_MAX = 32767`,
 * `NUMERIC_DSCALE_MAX = 16383`, or exponent `>= INT_MAX / 2`, SQLSTATE `22003`).
 */
function rawJsonHasOverflowNumber(raw: string): boolean {
  if (!raw.includes("e") && !raw.includes("E")) {
    return false;
  }
  let i = 0;
  while (i < raw.length) {
    const ch = codeAt(raw, i);
    if (ch === 0x22) {
      i = skipJsonString(raw, i);
    } else if (isJsonNumberStartCode(ch)) {
      const end = readJsonNumberEnd(raw, i);
      if (isPgNumericOverflowToken(raw.slice(i, end))) {
        return true;
      }
      i = end;
    } else {
      i += 1;
    }
  }
  return false;
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
 * Returns `true` if `sql` already ends with a trailing sqlcommenter block comment (outside
 * strings and `--` line comments) containing a single valid `auditstream` actor payload
 * (with optional trailing ASCII whitespace or semicolons).
 */
export function isTagged(sql: string): boolean {
  return decodeScope(sql).actorSource === "comment";
}

/**
 * Appends ` /*auditstream='<base64url>'*\/` (or `\n/*auditstream='<base64url>'*\/` when `sql`
 * ends inside a `--` single-line comment) to the end of `sql` for the active or supplied
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
  const needsNewline = sqlEndsInLineComment(sql);
  const cached = getCachedScopePayload(scope);
  if (cached !== undefined) {
    const encoded = getOrEncodeCached(cached);
    if (needsNewline) {
      return `${sql}\n/*auditstream='${encoded}'*/`;
    }
    if (cached.commentSuffix === undefined) {
      cached.commentSuffix = ` /*auditstream='${encoded}'*/`;
    }
    return `${sql}${cached.commentSuffix}`;
  }
  const encoded = encodeScope(scope);
  return needsNewline
    ? `${sql}\n/*auditstream='${encoded}'*/`
    : `${sql} /*auditstream='${encoded}'*/`;
}

function decodeCommentPayloadText(rawValue: string): string | null {
  const bytes = decodeBase64UrlUnpadded(rawValue);
  if (bytes === null || bytes.byteLength > MAX_PAYLOAD_BYTES) {
    return null;
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

function parseDecodedActorPayload(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    rawJsonHasInvalidEscape(text) ||
    rawJsonHasOverflowNumber(text) ||
    !isValidActorObject(parsed)
  ) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function absentDecode(): DecodedTransport {
  return { actor: null, context: null, actorSource: null };
}

function invalidDecode(): DecodedTransport {
  return { actor: null, context: null, actorSource: "invalid" };
}

/**
 * Decodes a trailing `/*auditstream='...'*\/` SQL comment from `sql` following the exact
 * extraction and validation rules in `spec/transport.md`.
 *
 * - Returns `{ actor: null, context: null, actorSource: null }` when no trailing comment
 *   or no `auditstream` key is present.
 * - Returns `{ actor: null, context: null, actorSource: "invalid" }` when an `auditstream`
 *   key is present but malformed, oversized (over 512 UTF-8 bytes or 683 chars), padded,
 *   invalid UTF-8, non-JSON, contains forbidden prototype keys, or violates the `spec/actor.md`
 *   actor/context schema (including the 5-value `type` enum, non-empty `id`/`tenant`, depth-1
 *   `onBehalfOf`, and object `context` with non-empty known fields).
 * - Preserves unknown additive keys in `actor`, `onBehalfOf`, and `context`.
 * - Never throws on malformed input.
 */
export function decodeScope(sql: string): DecodedTransport {
  const body = extractTrailingCommentBody(sql);
  if (body === null) {
    return absentDecode();
  }

  const parsedTag = parseAuditstreamFromCommentBody(body);
  if (parsedTag.kind === "absent") {
    return absentDecode();
  }
  if (parsedTag.kind === "invalid") {
    return invalidDecode();
  }

  const text = decodeCommentPayloadText(parsedTag.value);
  if (text === null) {
    return invalidDecode();
  }

  const parsedObj = parseDecodedActorPayload(text);
  if (parsedObj === null) {
    return invalidDecode();
  }

  let context: Record<string, unknown> | null = null;
  if (Object.hasOwn(parsedObj, "context")) {
    if (!isValidContextObject(parsedObj.context)) {
      return invalidDecode();
    }
    context = parsedObj.context;
  }

  const actor: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsedObj)) {
    if (key !== "context") {
      defineOwnDataProperty(actor, key, value);
    }
  }

  return { actor, context, actorSource: "comment" };
}
