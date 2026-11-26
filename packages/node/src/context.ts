import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Allowed actor categories defined by Auditstream Specification 0.1.0.
 */
export type ActorType = "user" | "api_key" | "ai_agent" | "service" | "system";

const VALID_ACTOR_TYPES: ReadonlySet<string> = new Set<ActorType>([
  "user",
  "api_key",
  "ai_agent",
  "service",
  "system",
]);

/**
 * Maximum UTF-8 byte length of the compact serialized actor + context JSON payload.
 */
export const MAX_PAYLOAD_BYTES: 512 = 512;

/**
 * A nested actor inside `Actor.onBehalfOf` (strictly one level deep; cannot carry `onBehalfOf`).
 */
export interface NestedActor {
  /** Category of the nested actor. */
  readonly type: ActorType;
  /** Non-empty opaque identifier for the nested actor. */
  readonly id: string;
  /** Optional non-empty opaque tenant or organization identifier. */
  readonly tenant?: string;
  /** Disallowed: `onBehalfOf` nesting is strictly limited to one level. */
  readonly onBehalfOf?: never;
}

/**
 * Actor payload defined by Auditstream Specification 0.1.0.
 */
export interface Actor {
  /** Actor category (`user`, `api_key`, `ai_agent`, `service`, or `system`). */
  readonly type: ActorType;
  /** Non-empty opaque identifier for the actor. */
  readonly id: string;
  /** Optional nested actor on whose behalf this actor acted (max depth 1). */
  readonly onBehalfOf?: NestedActor;
  /** Optional non-empty opaque tenant or organization identifier. */
  readonly tenant?: string;
}

/**
 * Optional execution context carried alongside an actor.
 *
 * `ip` and `userAgent` are opt-in only and should not be sent unless explicitly enabled.
 */
export interface AuditContext {
  /** Optional non-empty correlation identifier for the request or job. */
  readonly requestId?: string;
  /** Optional non-empty entry surface label (for example `web`, `api`, `cli`, `worker`). */
  readonly source?: string;
  /** Optional opt-in client IP address. */
  readonly ip?: string;
  /** Optional opt-in client user-agent string. */
  readonly userAgent?: string;
}

/**
 * Active actor and optional context stored in the current `AsyncLocalStorage` scope.
 */
export interface AuditScope {
  /** Validated actor for the current scope. */
  readonly actor: Actor;
  /** Optional validated context for the current scope. */
  readonly context?: AuditContext;
}

/**
 * Options accepted by {@link AuditNamespace.as}.
 */
export interface AuditAsOptions {
  /** Optional execution context attached to the actor scope. */
  readonly context?: AuditContext;
}

/**
 * Machine-readable error codes emitted by {@link AuditstreamError}.
 */
export type AuditstreamErrorCode =
  | "INVALID_ACTOR"
  | "INVALID_CONTEXT"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_EVENT"
  | "INVALID_RECORD"
  | "INVALID_QUERY";

/**
 * Error thrown by Auditstream when an actor or context payload violates Specification 0.1.0.
 */
export class AuditstreamError extends Error {
  /** Machine-readable error category. */
  public readonly code: AuditstreamErrorCode;

  /** Creates a new {@link AuditstreamError} with a machine-readable `code` and message. */
  public constructor(code: AuditstreamErrorCode, message: string) {
    super(message);
    this.name = "AuditstreamError";
    this.code = code;
  }
}

/**
 * Public `audit` namespace owning the single `AsyncLocalStorage` actor scope.
 */
export interface AuditNamespace {
  /**
   * Validates `actor` and optional `options.context`, runs `fn` inside an isolated
   * `AsyncLocalStorage` scope, and awaits the result inside the scope so lazy thenables
   * (such as Prisma queries) retain the actor.
   */
  as<T>(actor: Actor, fn: () => T | PromiseLike<T>, options?: AuditAsOptions): Promise<Awaited<T>>;

  /**
   * Returns the active `{ actor, context }` scope, or `undefined` outside any `audit.as()` call.
   */
  current(): AuditScope | undefined;
}

const textEncoder = new TextEncoder();

// Share one AsyncLocalStorage instance per JS runtime via a process-wide Symbol so
// multi-chunk server bundles (for example Next.js Turbopack Route Handlers and Server
// Actions sharing a globalThis Prisma client) always observe the same active actor scope.
const SCOPE_STORAGE_SYMBOL: unique symbol = Symbol.for("auditstream.node.scopeStorage.v1") as never;
// Older caches may contain text that the current serializer rejects.
const SCOPE_CACHE_SYMBOL: unique symbol = Symbol.for("auditstream.node.scopeCache.v2") as never;

/**
 * Internal cached canonical serialization and lazy encoded tag for an immutable `audit.as()` scope.
 */
export interface CachedScopePayload {
  readonly json: string;
  readonly bytes: Uint8Array;
  encoded?: string;
  commentSuffix?: string;
}

function getSharedScopeStorage(): AsyncLocalStorage<AuditScope> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[SCOPE_STORAGE_SYMBOL];
  if (existing instanceof AsyncLocalStorage) {
    return existing as AsyncLocalStorage<AuditScope>;
  }
  const created = new AsyncLocalStorage<AuditScope>();
  globalStore[SCOPE_STORAGE_SYMBOL] = created;
  return created;
}

function getSharedScopeCache(): WeakMap<AuditScope, CachedScopePayload> {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[SCOPE_CACHE_SYMBOL];
  if (existing instanceof WeakMap) {
    return existing as WeakMap<AuditScope, CachedScopePayload>;
  }
  const created = new WeakMap<AuditScope, CachedScopePayload>();
  globalStore[SCOPE_CACHE_SYMBOL] = created;
  return created;
}

const scopeStorage = getSharedScopeStorage();
const scopeCache = getSharedScopeCache();

/**
 * Internal lookup used by `transport.ts` to reuse canonical JSON, UTF-8 bytes, and encoded tags
 * for deeply frozen scopes created by `audit.as()`.
 */
export function getCachedScopePayload(scope: AuditScope): CachedScopePayload | undefined {
  return scopeCache.get(scope);
}

const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Internal check accepting plain objects (`Object.prototype` or `null` prototype) while
 * rejecting arrays, primitives, built-ins, and custom prototype chains.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    if (Array.isArray(value)) {
      return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/** Internal safe own-property lookup that never walks the prototype chain. */
export function getOwnValue(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Internal safe own data property setter immune to `__proto__` prototype hijacking. */
export function defineOwnDataProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function pushContainerChildren(current: object, stack: unknown[]): boolean {
  if (Array.isArray(current)) {
    for (const item of current) {
      stack.push(item);
    }
    return false;
  }
  for (const key of Object.keys(current)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      return true;
    }
    stack.push((current as Record<string, unknown>)[key]);
  }
  return false;
}

/**
 * Iteratively checks whether `value` (or any nested object/array inside it) contains an own
 * enumerable `"__proto__"`, `"constructor"`, or `"prototype"` key.
 */
export function hasForbiddenPrototypeKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (pushContainerChildren(current, stack)) {
      return true;
    }
  }
  return false;
}

const KNOWN_CONTEXT_FIELDS: readonly (keyof AuditContext)[] = [
  "requestId",
  "source",
  "ip",
  "userAgent",
];

/** Internal validated core fields shared by `Actor` and `NestedActor` validators/canonicalizers. */
export interface ValidatedActorCore {
  readonly type: ActorType;
  readonly id: string;
  readonly tenant: string | undefined;
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  code: AuditstreamErrorCode,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuditstreamError(code, `${field} must be a non-empty string`);
  }
}

/**
 * Validates that `raw` is a plain object containing no forbidden prototype keys
 * (`__proto__`, `constructor`, `prototype`), converting throwing getters/Proxy traps
 * into `AuditstreamError`.
 */
export function assertSafePlainObject(
  raw: unknown,
  field: string,
  code: AuditstreamErrorCode,
): asserts raw is Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new AuditstreamError(code, `${field} must be a JSON object`);
  }
  let forbidden: boolean;
  try {
    forbidden = hasForbiddenPrototypeKey(raw);
  } catch {
    throw new AuditstreamError(code, `${field} is not JSON-serializable`);
  }
  if (forbidden) {
    throw new AuditstreamError(
      code,
      `${field} must not contain __proto__, constructor, or prototype keys`,
    );
  }
}

/** Safely reads an own property without walking prototypes, trapping getter exceptions. */
export function readOwnPropertySafe(
  obj: Record<string, unknown>,
  key: string,
  field: string,
  code: AuditstreamErrorCode,
): unknown {
  try {
    return Object.hasOwn(obj, key) ? obj[key] : undefined;
  } catch {
    throw new AuditstreamError(code, `${field} is not readable`);
  }
}

/** Validates the shared `type`, `id`, `tenant`, and optional depth-1 `onBehalfOf` rules. */
export function readValidatedActorCore(
  raw: unknown,
  field: string,
  forbidOnBehalfOf: boolean,
): ValidatedActorCore {
  assertSafePlainObject(raw, field, "INVALID_ACTOR");
  const type = readOwnPropertySafe(raw, "type", `${field}.type`, "INVALID_ACTOR");
  if (typeof type !== "string" || !VALID_ACTOR_TYPES.has(type)) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      `${field}.type must be one of user, api_key, ai_agent, service, system`,
    );
  }
  const id = readOwnPropertySafe(raw, "id", `${field}.id`, "INVALID_ACTOR");
  assertNonEmptyString(id, `${field}.id`, "INVALID_ACTOR");
  if (
    forbidOnBehalfOf &&
    readOwnPropertySafe(raw, "onBehalfOf", `${field}.onBehalfOf`, "INVALID_ACTOR") !== undefined
  ) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      `${field} must not contain a nested onBehalfOf (max depth is 1)`,
    );
  }
  const tenant = readOwnPropertySafe(raw, "tenant", `${field}.tenant`, "INVALID_ACTOR");
  if (tenant !== undefined) {
    assertNonEmptyString(tenant, `${field}.tenant`, "INVALID_ACTOR");
  }
  return { type: type as ActorType, id, tenant };
}

/** Validates the known context fields and returns a fresh mutable plain object in canonical order. */
export function readValidatedKnownContext(raw: unknown): Record<string, unknown> {
  assertSafePlainObject(raw, "context", "INVALID_CONTEXT");
  const validated: Record<string, unknown> = {};
  for (const key of KNOWN_CONTEXT_FIELDS) {
    const value = readOwnPropertySafe(raw, key, `context.${key}`, "INVALID_CONTEXT");
    if (value !== undefined) {
      assertNonEmptyString(value, `context.${key}`, "INVALID_CONTEXT");
      validated[key] = value;
    }
  }
  return validated;
}

function validateNestedActor(raw: unknown): NestedActor {
  const { type, id, tenant } = readValidatedActorCore(raw, "actor.onBehalfOf", true);
  const nested: { type: ActorType; id: string; tenant?: string } = { type, id };
  if (tenant !== undefined) {
    nested.tenant = tenant;
  }
  return Object.freeze(nested);
}

function validateActor(raw: unknown): Actor {
  const { type, id, tenant } = readValidatedActorCore(raw, "actor", false);
  const rawOnBehalfOf = readOwnPropertySafe(
    raw as Record<string, unknown>,
    "onBehalfOf",
    "actor.onBehalfOf",
    "INVALID_ACTOR",
  );
  const onBehalfOf = rawOnBehalfOf === undefined ? undefined : validateNestedActor(rawOnBehalfOf);

  const actor: {
    type: ActorType;
    id: string;
    onBehalfOf?: NestedActor;
    tenant?: string;
  } = { type, id };
  if (onBehalfOf !== undefined) {
    actor.onBehalfOf = onBehalfOf;
  }
  if (tenant !== undefined) {
    actor.tenant = tenant;
  }
  return Object.freeze(actor);
}

function validateContext(raw: unknown): AuditContext {
  return Object.freeze(readValidatedKnownContext(raw)) as AuditContext;
}

function isInvalidTextString(value: string): boolean {
  // In Unicode mode a valid surrogate pair is one code point outside this range.
  return value.includes("\0") || /[\uD800-\uDFFF]/u.test(value);
}

/**
 * Internal check for text PostgreSQL cannot store or compare: NUL, or an unpaired UTF-16
 * surrogate in a string or in any key or value of a nested object or array.
 */
export function hasInvalidText(value: unknown): boolean {
  if (typeof value === "string") {
    return isInvalidTextString(value);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (isInvalidTextString(current)) {
        return true;
      }
      continue;
    }
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (Array.isArray(current)) {
      for (let i = 0; i < current.length; i++) {
        stack.push(current[i]);
      }
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (isInvalidTextString(key)) {
        return true;
      }
      stack.push(child);
    }
  }
  return false;
}

function hasSerializedForbiddenKeyToken(json: string): boolean {
  return (
    json.includes('"__proto__":') ||
    json.includes('"constructor":') ||
    json.includes('"prototype":')
  );
}

function validateSerializedEntry(
  key: string,
  value: unknown,
  needsKeyCheck: boolean,
  needsEscapeCheck: boolean,
): void {
  const code = key === "context" ? "INVALID_CONTEXT" : "INVALID_ACTOR";
  if (needsKeyCheck && (FORBIDDEN_OBJECT_KEYS.has(key) || hasForbiddenPrototypeKey(value))) {
    throw new AuditstreamError(
      code,
      "audit payload must not contain __proto__, constructor, or prototype keys",
    );
  }
  if (needsEscapeCheck && (hasInvalidText(key) || hasInvalidText(value))) {
    throw new AuditstreamError(
      code,
      "audit payload text must not contain NUL or unpaired surrogates",
    );
  }
}

function validateSerializedText(json: string): void {
  const needsEscapeCheck = json.includes("\\u");
  const needsKeyCheck = hasSerializedForbiddenKeyToken(json);
  if (!needsEscapeCheck && !needsKeyCheck) {
    return;
  }

  const fields = JSON.parse(json) as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    validateSerializedEntry(key, value, needsKeyCheck, needsEscapeCheck);
  }
}

function stringifyJsonObjectSafe(value: object, field: string, code: AuditstreamErrorCode): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new AuditstreamError(code, `${field} is not JSON-serializable`);
  }
  if (typeof json !== "string" || !json.startsWith("{")) {
    throw new AuditstreamError(code, `${field} must serialize to a JSON object`);
  }
  return json;
}

/**
 * Internal serialization shared by scoped and directly supplied transport payloads.
 * Serializes known actor fields, optional `context`, and optional actor extension fields
 * independently so every `toJSON()`/getter runs at most once and errors map cleanly to
 * `INVALID_ACTOR` vs `INVALID_CONTEXT`.
 */
export function serializeScopeParts(
  knownActor: object,
  context?: object,
  actorExtras?: object,
): CachedScopePayload {
  const knownJson = stringifyJsonObjectSafe(knownActor, "actor", "INVALID_ACTOR");
  const contextJson =
    context === undefined
      ? undefined
      : stringifyJsonObjectSafe(context, "context", "INVALID_CONTEXT");
  const extrasJson =
    actorExtras === undefined
      ? undefined
      : stringifyJsonObjectSafe(actorExtras, "actor", "INVALID_ACTOR");

  let json = knownJson;
  if (contextJson !== undefined || (extrasJson !== undefined && extrasJson.length > 2)) {
    const contextPart = contextJson === undefined ? "" : `,"context":${contextJson}`;
    const extrasPart =
      extrasJson !== undefined && extrasJson.length > 2 ? `,${extrasJson.slice(1, -1)}` : "";
    json = `${knownJson.slice(0, -1)}${contextPart}${extrasPart}}`;
  }

  const bytes = textEncoder.encode(json);
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new AuditstreamError(
      "PAYLOAD_TOO_LARGE",
      `serialized actor payload is ${bytes.byteLength} UTF-8 bytes, exceeding the ${MAX_PAYLOAD_BYTES}-byte limit`,
    );
  }

  validateSerializedText(json);
  return { json, bytes };
}

function buildValidatedScope(rawActor: unknown, rawContext: unknown): AuditScope {
  const actor = validateActor(rawActor);
  const context = rawContext === undefined ? undefined : validateContext(rawContext);

  const serialized = serializeScopeParts(actor, context);

  const scope: { actor: Actor; context?: AuditContext } = { actor };
  if (context !== undefined) {
    scope.context = context;
  }
  const frozenScope: AuditScope = Object.freeze(scope);
  scopeCache.set(frozenScope, serialized);
  return frozenScope;
}

function readOptionsContext(options: AuditAsOptions | undefined): unknown {
  if (options === undefined) {
    return undefined;
  }
  try {
    return options.context;
  } catch {
    throw new AuditstreamError("INVALID_CONTEXT", "context is not readable");
  }
}

/**
 * Shared Auditstream runtime entry point providing `audit.as()` and `audit.current()`.
 */
export const audit: AuditNamespace = {
  async as<T>(
    actor: Actor,
    fn: () => T | PromiseLike<T>,
    options?: AuditAsOptions,
  ): Promise<Awaited<T>> {
    const scope = buildValidatedScope(actor, readOptionsContext(options));
    return await scopeStorage.run(scope, async () => await fn());
  },

  current(): AuditScope | undefined {
    return scopeStorage.getStore();
  },
};
