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
  type AuditHistoryExecutor,
  type AuditHistoryQuery,
  type AuditHistoryQueryResult,
  type AuditHistoryValues,
  type AuditOp,
  type DbOp,
  DEFAULT_HISTORY_LIMIT,
  type EventSourceKind,
  type ExportRecord,
  type HistoryEntry,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  MAX_HISTORY_LIMIT,
  parseExportRecord,
  readHistory,
  SUPPORTED_SCHEMA_VERSION,
} from "./history.js";
import {
  type AuditLogEvent,
  type AuditLogExecutor,
  type AuditLogValues,
  LOG_EVENT_SQL,
  logEvent,
  MAX_ACTION_LENGTH,
} from "./log.js";
import {
  type AuditQuery,
  type AuditQueryExecutor,
  type AuditQueryPage,
  type AuditQueryValues,
  MAX_QUERY_OPS,
  queryHistory,
} from "./query.js";

/** Package identifier exported by the workspace skeleton. */
export const PACKAGE_NAME: "@auditstream/node" = "@auditstream/node";

/**
 * Public `audit` namespace owning actor context propagation (`audit.as()`, `audit.current()`),
 * application event logging (`audit.log()`), and typed record history lookups (`audit.history()`).
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

  /**
   * Reads recorded audit history for a single record from `{schema}.changes`, ordered newest first
   * (`occurred_at DESC, id DESC`), using the caller's database connection (`exec`).
   */
  history(exec: AuditHistoryExecutor, query: AuditHistoryQuery): Promise<HistoryEntry[]>;

  /**
   * Queries `{schema}.changes` (including application events logged with `audit.log()`) using
   * validated filters and lossless microsecond keyset pagination (`occurred_at DESC, id DESC`).
   */
  query(exec: AuditQueryExecutor, query: AuditQuery): Promise<AuditQueryPage>;
}

/**
 * Shared Auditstream runtime entry point providing `audit.as()`, `audit.current()`,
 * `audit.log()`, `audit.history()`, and `audit.query()`.
 */
export const audit: AuditNamespace = Object.freeze({
  as: contextAudit.as,
  current: contextAudit.current,
  log: logEvent,
  history: readHistory,
  query: queryHistory,
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
  type AuditHistoryExecutor,
  type AuditHistoryQuery,
  type AuditHistoryQueryResult,
  type AuditHistoryValues,
  type AuditLogEvent,
  type AuditLogExecutor,
  type AuditLogValues,
  type AuditOp,
  type AuditQuery,
  type AuditQueryExecutor,
  type AuditQueryPage,
  type AuditQueryValues,
  type AuditScope,
  AuditstreamError,
  type AuditstreamErrorCode,
  type DbOp,
  DEFAULT_HISTORY_LIMIT,
  type EventSourceKind,
  type ExportRecord,
  type HistoryEntry,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  LOG_EVENT_SQL,
  MAX_ACTION_LENGTH,
  MAX_HISTORY_LIMIT,
  MAX_PAYLOAD_BYTES,
  MAX_QUERY_OPS,
  type NestedActor,
  parseExportRecord,
  SUPPORTED_SCHEMA_VERSION,
};
