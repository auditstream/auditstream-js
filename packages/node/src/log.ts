import { AuditstreamError } from "./context.js";

/**
 * Maximum Unicode code point length of an application event `action` per Auditstream Specification 0.1.0.
 */
export const MAX_ACTION_LENGTH: 64 = 64;

/**
 * Parameterized SQL statement executed by `audit.log()` to record an application event through
 * `auditstream.log_event(text, jsonb, jsonb)`.
 */
export const LOG_EVENT_SQL: "SELECT auditstream.log_event($1::text, $2::jsonb, $3::jsonb)" =
  "SELECT auditstream.log_event($1::text, $2::jsonb, $3::jsonb)";

/**
 * Ordered parameter tuple passed to an {@link AuditLogExecutor}:
 * `[action, targetJsonOrNull, dataJsonOrNull]`.
 */
export type AuditLogValues = [action: string, target: string | null, data: string | null];

/**
 * Callback that executes one parameterized SQL statement on the caller's audited database client.
 */
export type AuditLogExecutor = (
  text: string,
  values: AuditLogValues,
) => unknown | PromiseLike<unknown>;

/**
 * Application-level audit event payload accepted by `audit.log()`.
 */
export interface AuditLogEvent {
  /**
   * Application action name written to `auditstream.changes.op`.
   * Must have trimmed length between 1 and 64 characters and must not be
   * `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` (case-insensitive).
   */
  readonly action: string;
  /** Optional JSON object written to `auditstream.changes.record_id` (`NULL` when omitted or `null`). */
  readonly target?: Record<string, unknown> | null | undefined;
  /** Optional JSON object written to `auditstream.changes.after` (`NULL` when omitted or `null`). */
  readonly data?: Record<string, unknown> | null | undefined;
}

const RESERVED_ACTIONS: ReadonlySet<string> = new Set(["INSERT", "UPDATE", "DELETE", "TRUNCATE"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAction(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AuditstreamError("INVALID_EVENT", "event.action must be a string");
  }
  if (raw.trim().length < 1) {
    throw new AuditstreamError(
      "INVALID_EVENT",
      "event.action must have trimmed length of at least 1 character",
    );
  }
  const codePointLength = [...raw].length;
  if (codePointLength > MAX_ACTION_LENGTH) {
    throw new AuditstreamError(
      "INVALID_EVENT",
      `event.action is ${codePointLength} characters, exceeding the ${MAX_ACTION_LENGTH}-character limit`,
    );
  }
  if (RESERVED_ACTIONS.has(raw.toUpperCase()) || RESERVED_ACTIONS.has(raw.trim().toUpperCase())) {
    throw new AuditstreamError(
      "INVALID_EVENT",
      `event.action must not be one of INSERT, UPDATE, DELETE, or TRUNCATE (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

function serializeOptionalJsonObject(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new AuditstreamError("INVALID_EVENT", `${field} must be a JSON object or null`);
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AuditstreamError("INVALID_EVENT", `${field} is not JSON-serializable: ${detail}`);
  }

  if (typeof serialized !== "string" || !serialized.startsWith("{")) {
    throw new AuditstreamError("INVALID_EVENT", `${field} must serialize to a JSON object`);
  }
  return serialized;
}

function buildLogValues(event: unknown): AuditLogValues {
  if (!isPlainObject(event)) {
    throw new AuditstreamError("INVALID_EVENT", "event must be a JSON object");
  }
  const action = validateAction(event.action);
  const target = serializeOptionalJsonObject(event.target, "event.target");
  const data = serializeOptionalJsonObject(event.data, "event.data");
  return [action, target, data];
}

/**
 * Validates `event` against Auditstream Specification 0.1.0 and executes
 * `SELECT auditstream.log_event($1::text, $2::jsonb, $3::jsonb)` through `exec`
 * inside the caller's active `AsyncLocalStorage` actor scope.
 *
 * @throws {@link AuditstreamError} if `exec` is not a function or `event` violates Specification 0.1.0.
 */
export async function logEvent(exec: AuditLogExecutor, event: AuditLogEvent): Promise<void> {
  if (typeof exec !== "function") {
    throw new AuditstreamError("INVALID_EVENT", "exec must be a function");
  }
  const values = buildLogValues(event);
  await exec(LOG_EVENT_SQL, values);
}
