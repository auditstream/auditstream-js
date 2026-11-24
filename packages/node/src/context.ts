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

const scopeStorage = getSharedScopeStorage();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function validateNestedActor(raw: unknown): NestedActor {
  if (!isPlainObject(raw)) {
    throw new AuditstreamError("INVALID_ACTOR", "actor.onBehalfOf must be a JSON object");
  }
  if (typeof raw.type !== "string" || !VALID_ACTOR_TYPES.has(raw.type)) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      `actor.onBehalfOf.type must be one of user, api_key, ai_agent, service, system`,
    );
  }
  assertNonEmptyString(raw.id, "actor.onBehalfOf.id", "INVALID_ACTOR");
  if (raw.tenant !== undefined) {
    assertNonEmptyString(raw.tenant, "actor.onBehalfOf.tenant", "INVALID_ACTOR");
  }
  if ("onBehalfOf" in raw && raw.onBehalfOf !== undefined) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      "actor.onBehalfOf must not contain a nested onBehalfOf (max depth is 1)",
    );
  }

  const nested: { type: ActorType; id: string; tenant?: string } = {
    type: raw.type as ActorType,
    id: raw.id,
  };
  if (raw.tenant !== undefined) {
    nested.tenant = raw.tenant;
  }
  return Object.freeze(nested);
}

function validateActor(raw: unknown): Actor {
  if (!isPlainObject(raw)) {
    throw new AuditstreamError("INVALID_ACTOR", "actor must be a JSON object");
  }
  if (typeof raw.type !== "string" || !VALID_ACTOR_TYPES.has(raw.type)) {
    throw new AuditstreamError(
      "INVALID_ACTOR",
      `actor.type must be one of user, api_key, ai_agent, service, system`,
    );
  }
  assertNonEmptyString(raw.id, "actor.id", "INVALID_ACTOR");

  let onBehalfOf: NestedActor | undefined;
  if (raw.onBehalfOf !== undefined) {
    onBehalfOf = validateNestedActor(raw.onBehalfOf);
  }

  if (raw.tenant !== undefined) {
    assertNonEmptyString(raw.tenant, "actor.tenant", "INVALID_ACTOR");
  }

  const actor: {
    type: ActorType;
    id: string;
    onBehalfOf?: NestedActor;
    tenant?: string;
  } = {
    type: raw.type as ActorType,
    id: raw.id,
  };
  if (onBehalfOf !== undefined) {
    actor.onBehalfOf = onBehalfOf;
  }
  if (raw.tenant !== undefined) {
    actor.tenant = raw.tenant;
  }
  return Object.freeze(actor);
}

function validateContext(raw: unknown): AuditContext {
  if (!isPlainObject(raw)) {
    throw new AuditstreamError("INVALID_CONTEXT", "context must be a JSON object");
  }

  const context: {
    requestId?: string;
    source?: string;
    ip?: string;
    userAgent?: string;
  } = {};

  if (raw.requestId !== undefined) {
    assertNonEmptyString(raw.requestId, "context.requestId", "INVALID_CONTEXT");
    context.requestId = raw.requestId;
  }
  if (raw.source !== undefined) {
    assertNonEmptyString(raw.source, "context.source", "INVALID_CONTEXT");
    context.source = raw.source;
  }
  if (raw.ip !== undefined) {
    assertNonEmptyString(raw.ip, "context.ip", "INVALID_CONTEXT");
    context.ip = raw.ip;
  }
  if (raw.userAgent !== undefined) {
    assertNonEmptyString(raw.userAgent, "context.userAgent", "INVALID_CONTEXT");
    context.userAgent = raw.userAgent;
  }

  return Object.freeze(context);
}

function buildValidatedScope(rawActor: unknown, rawContext: unknown): AuditScope {
  const actor = validateActor(rawActor);
  const context = rawContext === undefined ? undefined : validateContext(rawContext);

  const payload = context === undefined ? actor : { ...actor, context };
  const serialized = JSON.stringify(payload);
  const byteLength = textEncoder.encode(serialized).byteLength;

  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new AuditstreamError(
      "PAYLOAD_TOO_LARGE",
      `serialized actor payload is ${byteLength} UTF-8 bytes, exceeding the ${MAX_PAYLOAD_BYTES}-byte limit`,
    );
  }

  const scope: { actor: Actor; context?: AuditContext } = { actor };
  if (context !== undefined) {
    scope.context = context;
  }
  return Object.freeze(scope);
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
    const scope = buildValidatedScope(actor, options?.context);
    return await scopeStorage.run(scope, async () => await fn());
  },

  current(): AuditScope | undefined {
    return scopeStorage.getStore();
  },
};
