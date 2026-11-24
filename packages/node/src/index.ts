import {
  type Actor,
  type ActorType,
  type AuditAsOptions,
  type AuditContext,
  type AuditScope,
  AuditstreamError,
  type AuditstreamErrorCode,
  audit as contextAudit,
  MAX_PAYLOAD_BYTES,
  type NestedActor,
} from "./context.js";
import {
  type AuditLogEvent,
  type AuditLogExecutor,
  type AuditLogValues,
  LOG_EVENT_SQL,
  logEvent,
  MAX_ACTION_LENGTH,
} from "./log.js";

/** Package identifier exported by the workspace skeleton. */
export const PACKAGE_NAME: "@auditstream/node" = "@auditstream/node";

/**
 * Public `audit` namespace owning actor context propagation (`audit.as()`, `audit.current()`)
 * and application event logging (`audit.log()`).
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

  /**
   * Records an application-level audit event through `auditstream.log_event($1::text, $2::jsonb, $3::jsonb)`
   * using the caller's audited database client (`exec`).
   *
   * Validates the event against Specification 0.1.0 before calling `exec`, runs `exec` inside the
   * caller's active `audit.as()` scope, propagates errors from `exec` unchanged, and resolves to `undefined`.
   */
  log(exec: AuditLogExecutor, event: AuditLogEvent): Promise<void>;
}

/**
 * Shared Auditstream runtime entry point providing `audit.as()`, `audit.current()`, and `audit.log()`.
 */
export const audit: AuditNamespace = Object.freeze({
  as: contextAudit.as,
  current: contextAudit.current,
  log: logEvent,
});

export {
  type ActorSource,
  type DecodedTransport,
  decodeScope,
  encodeScope,
  isTagged,
  MAX_ENCODED_COMMENT_CHARS,
  setConfigValue,
  tagSql,
} from "./transport.js";
export {
  type Actor,
  type ActorType,
  type AuditAsOptions,
  type AuditContext,
  type AuditLogEvent,
  type AuditLogExecutor,
  type AuditLogValues,
  type AuditScope,
  AuditstreamError,
  type AuditstreamErrorCode,
  LOG_EVENT_SQL,
  MAX_ACTION_LENGTH,
  MAX_PAYLOAD_BYTES,
  type NestedActor,
};
