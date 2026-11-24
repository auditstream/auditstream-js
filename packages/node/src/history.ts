import { type Actor, type AuditContext, AuditstreamError } from "./context.js";
import type { ActorSource } from "./transport.js";

/**
 * Auditstream history schema version supported by Specification 0.1.0.
 */
export const SUPPORTED_SCHEMA_VERSION: 1 = 1;

/**
 * Default row limit applied by `audit.history()` when `limit` is omitted.
 */
export const DEFAULT_HISTORY_LIMIT: 50 = 50;

/**
 * Maximum row limit accepted by `audit.history()`.
 */
export const MAX_HISTORY_LIMIT: 1000 = 1000;

/**
 * Origin of a recorded audit event (`"db"` for trigger capture, `"app"` for `auditstream.log_event()`).
 */
export type EventSourceKind = "db" | "app";

/**
 * Database DML operations recorded by capture triggers.
 */
export type DbOp = "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";

/**
 * Recorded event operation: one of the database DML operations (`INSERT`, `UPDATE`, `DELETE`,
 * `TRUNCATE`) or an application action name from `auditstream.log_event()`.
 */
export type AuditOp = DbOp | (string & {});

/**
 * Primitive JSON value preserved inside row snapshots and `record_id`.
 *
 * Arbitrary-precision PostgreSQL `numeric` values that cannot be represented exactly as an
 * IEEE-754 `number` are preserved as verbatim decimal strings by {@link parseExportRecord}.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * Recursive JSON value used inside history row snapshots (`record_id`, `before`, `after`).
 */
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * JSON object mapping column or field names to JSON values.
 */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Single row from `auditstream.changes` matching Auditstream Specification 0.1.0
 * (`spec/history-table.md`).
 *
 * `id` (`bigint`) and `xact_id` (`xid8`) are typed as strings because JavaScript database
 * drivers return 64-bit PostgreSQL integers as strings to avoid IEEE-754 precision loss.
 */
export interface HistoryEntry {
  /** Monotonic insert sequence (`bigint` returned as a decimal string; insert order, not commit order). */
  readonly id: string;
  /** Stable UUID identifying the event for downstream deduplication. */
  readonly event_id: string;
  /** RFC 3339 UTC timestamp with microsecond precision when the row was recorded. */
  readonly occurred_at: string;
  /** 64-bit PostgreSQL transaction ID (`xid8` returned as a decimal string). */
  readonly xact_id: string;
  /** Origin of the event (`"db"` or `"app"`). */
  readonly source: EventSourceKind;
  /** Audited table schema for `"db"` events, or `null` for `"app"` events. */
  readonly schema_name: string | null;
  /** Audited table name for `"db"` events, or `null` for `"app"` events. */
  readonly table_name: string | null;
  /** Audited table OID (`TG_RELID`) for `"db"` events, or `null` for `"app"` events. */
  readonly table_oid: number | null;
  /** DML operation (`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`) or application action name. */
  readonly op: AuditOp;
  /** Primary key JSON object (or `target` for `"app"` events), or `null`. */
  readonly record_id: JsonObject | null;
  /** Pre-change row image minus excluded columns (`UPDATE` and `DELETE` only), or `null`. */
  readonly before: JsonObject | null;
  /** Post-change row image minus excluded columns (or `data` for `"app"` events), or `null`. */
  readonly after: JsonObject | null;
  /** Changed column names on `UPDATE`, or `null` otherwise. */
  readonly changed: readonly string[] | null;
  /** Resolved actor payload (without `context`), or `null` when absent or malformed. */
  readonly actor: Actor | null;
  /** Resolved execution context payload, or `null` when absent or malformed. */
  readonly context: AuditContext | null;
  /** Transport mechanism that supplied the actor (`set_config`, `comment`, `jwt`, `invalid`), or `null`. */
  readonly actor_source: ActorSource | null;
  /** Database session role (`session_user`) that initiated the write. */
  readonly db_user: string;
  /** History table layout version (`1` in Specification 0.1.0). */
  readonly schema_version: number;
}

/**
 * Single exported audit event record matching Auditstream Specification 0.1.0
 * (`spec/export.md` and `spec/schemas/event.schema.json`).
 *
 * Internal history columns (`id`, `xact_id`, and `table_oid`) are intentionally omitted.
 */
export interface ExportRecord {
  /** Stable UUID identifying the event for downstream deduplication. */
  readonly event_id: string;
  /** RFC 3339 UTC timestamp with microsecond precision. */
  readonly occurred_at: string;
  /** Origin of the event (`"db"` or `"app"`). */
  readonly source: EventSourceKind;
  /** Audited table schema for `"db"` events, or `null` for `"app"` events. */
  readonly schema_name: string | null;
  /** Audited table name for `"db"` events, or `null` for `"app"` events. */
  readonly table_name: string | null;
  /** DML operation (`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`) or application action name. */
  readonly op: AuditOp;
  /** Primary key JSON object (or `target` for `"app"` events), or `null`. */
  readonly record_id: JsonObject | null;
  /** Pre-change row image minus excluded columns (`UPDATE` and `DELETE` only), or `null`. */
  readonly before: JsonObject | null;
  /** Post-change row image minus excluded columns (or `data` for `"app"` events), or `null`. */
  readonly after: JsonObject | null;
  /** Changed column names on `UPDATE`, or `null` otherwise. */
  readonly changed: readonly string[] | null;
  /** Resolved actor payload (without `context`), or `null` when absent or malformed. */
  readonly actor: Actor | null;
  /** Resolved execution context payload, or `null` when absent or malformed. */
  readonly context: AuditContext | null;
  /** Transport mechanism that supplied the actor (`set_config`, `comment`, `jwt`, `invalid`), or `null`. */
  readonly actor_source: ActorSource | null;
  /** Database session role (`session_user`) that initiated the write. */
  readonly db_user: string;
  /** Export schema version (`1` in Specification 0.1.0). */
  readonly schema_version: number;
}

/**
 * Ordered parameter tuple passed to an {@link AuditHistoryExecutor}:
 * `[tableName, recordIdJson, limit]`.
 */
export type AuditHistoryValues = [table: string, recordIdJson: string, limit: number];

/**
 * Result shape accepted from an {@link AuditHistoryExecutor} (either a `pg`-style `{ rows }`
 * object or a direct row array such as `postgres.js` or `@neondatabase/serverless`).
 */
export type AuditHistoryQueryResult =
  | readonly Record<string, unknown>[]
  | { readonly rows: readonly Record<string, unknown>[] };

/**
 * Callback that executes one parameterized `SELECT` against the history table using the
 * application's own database connection (which holds `SELECT` on `auditstream.changes`).
 */
export type AuditHistoryExecutor = (
  text: string,
  values: AuditHistoryValues,
) => AuditHistoryQueryResult | PromiseLike<AuditHistoryQueryResult>;

/**
 * Query options accepted by `audit.history()`.
 */
export interface AuditHistoryQuery {
  /** Audited table name (`table_name`). */
  readonly table: string;
  /** Primary key JSON object matching `record_id = $2::jsonb` (for example `{ id: 101 }`). */
  readonly recordId: JsonObject;
  /**
   * Audit schema name (defaults to `"auditstream"`).
   * Must match `^[a-z_][a-z0-9_]*$`; invalid schema names throw {@link AuditstreamError}
   * before any SQL is sent.
   */
  readonly schema?: string | undefined;
  /** Maximum number of rows to return (default `50`, maximum `1000`). */
  readonly limit?: number | undefined;
}

/** Internal schema identifier validation pattern shared with `query.ts`. */
export const VALID_SCHEMA_PATTERN: RegExp = /^[a-z_][a-z0-9_]*$/;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RFC3339_UTC_MICROS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const VALID_ACTOR_SOURCES: ReadonlySet<string> = new Set<ActorSource>([
  "set_config",
  "comment",
  "jwt",
  "invalid",
]);
const VALID_SOURCES: ReadonlySet<string> = new Set<EventSourceKind>(["db", "app"]);

/** Internal SQL projection list for the 18 normative history columns shared with `query.ts`. */
export const HISTORY_SELECT_COLUMNS: string =
  `id::text AS id, event_id::text AS event_id, ` +
  `pg_catalog.to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, ` +
  `xact_id::text AS xact_id, ` +
  `source, schema_name, table_name, table_oid, op, record_id, before, after, changed, ` +
  `actor, context, actor_source, db_user, schema_version`;

interface JsonParseReviverContext {
  readonly source?: string;
}

type JsonParseWithContext = (
  text: string,
  reviver?: (
    this: unknown,
    key: string,
    value: unknown,
    context?: JsonParseReviverContext,
  ) => unknown,
) => unknown;

/** Internal plain-object check shared with `query.ts`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a JSON decimal literal to `sign|digits|exp` so we can detect whether converting
 * the literal to an IEEE-754 binary64 `number` lost precision.
 */
function canonicalDecimalKey(raw: string): string | null {
  const s = raw.trim();
  const negative = s.startsWith("-");
  const unsigned = negative ? s.slice(1) : s.startsWith("+") ? s.slice(1) : s;
  const eIdx = unsigned.search(/[eE]/);
  const mantissa = eIdx >= 0 ? unsigned.slice(0, eIdx) : unsigned;
  const explicitExp = eIdx >= 0 ? Number.parseInt(unsigned.slice(eIdx + 1), 10) : 0;
  if (!Number.isFinite(explicitExp)) {
    return null;
  }
  const dotIdx = mantissa.indexOf(".");
  const intPart = dotIdx >= 0 ? mantissa.slice(0, dotIdx) : mantissa;
  const fracPart = dotIdx >= 0 ? mantissa.slice(dotIdx + 1) : "";
  const combined = intPart + fracPart;
  if (!/^\d+$/.test(combined)) {
    return null;
  }

  const firstNonZero = combined.search(/[1-9]/);
  if (firstNonZero < 0) {
    return "0|0";
  }

  let lastNonZero = combined.length - 1;
  while (lastNonZero > firstNonZero && combined.charAt(lastNonZero) === "0") {
    lastNonZero -= 1;
  }
  const sigDigits = combined.slice(firstNonZero, lastNonZero + 1);
  const trailingZeros = combined.length - 1 - lastNonZero;
  const exp = explicitExp - fracPart.length + trailingZeros;
  return `${negative ? "-" : ""}${sigDigits}e${exp}`;
}

function preservesExactNumericValue(value: number, source: string): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  // Safe integers are exact in IEEE-754 binary64 if and only if they have no fractional part
  // and match the canonical decimal representation.
  const srcKey = canonicalDecimalKey(source);
  const valKey = canonicalDecimalKey(String(value));
  return srcKey !== null && valKey !== null && srcKey === valKey;
}

function validateNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new AuditstreamError("INVALID_RECORD", `${field} must be a non-empty string or null`);
  }
  return value;
}

function validateNullableObject(value: unknown, field: string): JsonObject | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new AuditstreamError("INVALID_RECORD", `${field} must be a JSON object or null`);
  }
  return value as JsonObject;
}

function validateNullableStringArray(value: unknown, field: string): readonly string[] | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new AuditstreamError(
      "INVALID_RECORD",
      `${field} must be an array of non-empty strings or null`,
    );
  }
  return value as readonly string[];
}

function validateNullableActor(value: unknown): Actor | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (
    !isPlainObject(value) ||
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    typeof value.id !== "string" ||
    value.id.length === 0
  ) {
    throw new AuditstreamError(
      "INVALID_RECORD",
      "actor must be null or an object with non-empty string type and id",
    );
  }
  return value as unknown as Actor;
}

function validateNullableActorSource(value: unknown): ActorSource | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !VALID_ACTOR_SOURCES.has(value)) {
    throw new AuditstreamError(
      "INVALID_RECORD",
      `actor_source must be one of set_config, comment, jwt, invalid, or null`,
    );
  }
  return value as ActorSource;
}

/**
 * Parses and validates a single JSON Lines export record against Auditstream Specification 0.1.0
 * (`spec/export.md` and `spec/schemas/event.schema.json`).
 *
 * - Validates every required field (`event_id`, `occurred_at`, `source`, `op`, `db_user`,
 *   `schema_version`) and requires `schema_version === 1`. Throws {@link AuditstreamError}
 *   (`INVALID_RECORD`) on malformed JSON, missing fields, invalid types, or unsupported
 *   `schema_version`.
 * - Ignores unknown additive fields for forward compatibility.
 * - **Arbitrary-precision `numeric` preservation:** uses ES2025 `JSON.parse` reviver source text
 *   access (`context.source`) so PostgreSQL `numeric` values that would lose precision in
 *   IEEE-754 binary64 (such as 30-digit decimals or integers beyond `Number.MAX_SAFE_INTEGER`)
 *   are returned verbatim as strings rather than rounded doubles.
 * - **Runtime support for `context.source`:** supported on Node.js 22.12+ (all supported Node
 *   versions), Deno 2+, Bun 1.2+, and Cloudflare Workers (V8 12.4+). Runtimes without
 *   `JSON.parse` source text access fall back to standard JavaScript `number` values.
 */
export function parseExportRecord(line: string): ExportRecord {
  if (typeof line !== "string" || line.trim().length === 0) {
    throw new AuditstreamError("INVALID_RECORD", "export record line must be a non-empty string");
  }

  let parsed: unknown;
  try {
    const parse = JSON.parse as JsonParseWithContext;
    parsed = parse(line, (_key, value, context) => {
      if (
        typeof value === "number" &&
        context !== undefined &&
        typeof context.source === "string" &&
        !preservesExactNumericValue(value, context.source)
      ) {
        return context.source;
      }
      return value;
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AuditstreamError("INVALID_RECORD", `invalid JSON in export record: ${detail}`);
  }

  if (!isPlainObject(parsed)) {
    throw new AuditstreamError("INVALID_RECORD", "export record must be a JSON object");
  }

  if (typeof parsed.event_id !== "string" || !UUID_PATTERN.test(parsed.event_id)) {
    throw new AuditstreamError("INVALID_RECORD", "event_id must be a valid UUID string");
  }
  if (
    typeof parsed.occurred_at !== "string" ||
    !RFC3339_UTC_MICROS_PATTERN.test(parsed.occurred_at)
  ) {
    throw new AuditstreamError(
      "INVALID_RECORD",
      "occurred_at must be an RFC 3339 UTC timestamp with 6 fractional digits",
    );
  }
  if (typeof parsed.source !== "string" || !VALID_SOURCES.has(parsed.source)) {
    throw new AuditstreamError("INVALID_RECORD", 'source must be "db" or "app"');
  }
  if (typeof parsed.op !== "string" || parsed.op.length < 1 || parsed.op.length > 64) {
    throw new AuditstreamError("INVALID_RECORD", "op must be a string between 1 and 64 characters");
  }
  if (typeof parsed.db_user !== "string" || parsed.db_user.length === 0) {
    throw new AuditstreamError("INVALID_RECORD", "db_user must be a non-empty string");
  }
  if (parsed.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new AuditstreamError(
      "INVALID_RECORD",
      `unsupported schema_version ${String(parsed.schema_version)} (expected ${SUPPORTED_SCHEMA_VERSION})`,
    );
  }

  return {
    event_id: parsed.event_id,
    occurred_at: parsed.occurred_at,
    source: parsed.source as EventSourceKind,
    schema_name: validateNullableString(parsed.schema_name, "schema_name"),
    table_name: validateNullableString(parsed.table_name, "table_name"),
    op: parsed.op,
    record_id: validateNullableObject(parsed.record_id, "record_id"),
    before: validateNullableObject(parsed.before, "before"),
    after: validateNullableObject(parsed.after, "after"),
    changed: validateNullableStringArray(parsed.changed, "changed"),
    actor: validateNullableActor(parsed.actor),
    context: validateNullableObject(parsed.context, "context") as AuditContext | null,
    actor_source: validateNullableActorSource(parsed.actor_source),
    db_user: parsed.db_user,
    schema_version: parsed.schema_version,
  };
}

function normalizeTimestamp(raw: unknown): string {
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === "string" && raw.length > 0) {
    return raw;
  }
  throw new AuditstreamError("INVALID_RECORD", "history row occurred_at must be a Date or string");
}

function normalizeTableOid(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === "number") {
    return raw;
  }
  if (typeof raw === "string") {
    const num = Number(raw);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  throw new AuditstreamError("INVALID_RECORD", "history row table_oid must be a number or null");
}

/** Internal row decoder shared with `query.ts`. */
export function rowToHistoryEntry(row: Record<string, unknown>): HistoryEntry {
  const id =
    typeof row.id === "string" ? row.id : typeof row.id === "number" ? String(row.id) : null;
  if (id === null || id.length === 0) {
    throw new AuditstreamError("INVALID_RECORD", "history row missing id");
  }
  const xactId =
    typeof row.xact_id === "string"
      ? row.xact_id
      : typeof row.xact_id === "number"
        ? String(row.xact_id)
        : null;
  if (xactId === null || xactId.length === 0) {
    throw new AuditstreamError("INVALID_RECORD", "history row missing xact_id");
  }
  if (typeof row.event_id !== "string" || row.event_id.length === 0) {
    throw new AuditstreamError("INVALID_RECORD", "history row missing event_id");
  }
  if (typeof row.source !== "string" || !VALID_SOURCES.has(row.source)) {
    throw new AuditstreamError("INVALID_RECORD", 'history row source must be "db" or "app"');
  }
  if (typeof row.op !== "string" || row.op.length === 0) {
    throw new AuditstreamError("INVALID_RECORD", "history row missing op");
  }
  if (typeof row.db_user !== "string" || row.db_user.length === 0) {
    throw new AuditstreamError("INVALID_RECORD", "history row missing db_user");
  }
  const schemaVersion =
    typeof row.schema_version === "number"
      ? row.schema_version
      : typeof row.schema_version === "string"
        ? Number(row.schema_version)
        : Number.NaN;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new AuditstreamError("INVALID_RECORD", "history row has invalid schema_version");
  }

  return {
    id,
    event_id: row.event_id,
    occurred_at: normalizeTimestamp(row.occurred_at),
    xact_id: xactId,
    source: row.source as EventSourceKind,
    schema_name: validateNullableString(row.schema_name, "schema_name"),
    table_name: validateNullableString(row.table_name, "table_name"),
    table_oid: normalizeTableOid(row.table_oid),
    op: row.op,
    record_id: validateNullableObject(row.record_id, "record_id"),
    before: validateNullableObject(row.before, "before"),
    after: validateNullableObject(row.after, "after"),
    changed: validateNullableStringArray(row.changed, "changed"),
    actor: validateNullableActor(row.actor),
    context: validateNullableObject(row.context, "context") as AuditContext | null,
    actor_source: validateNullableActorSource(row.actor_source),
    db_user: row.db_user,
    schema_version: schemaVersion,
  };
}

/**
 * Reads recorded audit history for a single record from `{schema}.changes`, ordered newest first
 * (`occurred_at DESC, id DESC`).
 *
 * - Sends one parameterized `SELECT` selecting only the 18 normative columns from
 *   `spec/history-table.md`, bound as `($1::text, $2::jsonb, $3::int)`.
 * - Validates `schema` against `^[a-z_][a-z0-9_]*$` before sending any SQL and double-quotes
 *   the identifier in the query.
 * - Defaults `limit` to `50` and enforces `1..=1000` (clamping values above `1000`? No,
 *   values above `1000` or below `1` throw {@link AuditstreamError} `INVALID_QUERY`).
 */
export async function readHistory(
  exec: AuditHistoryExecutor,
  query: AuditHistoryQuery,
): Promise<HistoryEntry[]> {
  if (typeof exec !== "function") {
    throw new AuditstreamError("INVALID_QUERY", "exec must be a function");
  }
  if (!isPlainObject(query)) {
    throw new AuditstreamError("INVALID_QUERY", "query must be an object");
  }
  if (typeof query.table !== "string" || query.table.trim().length === 0) {
    throw new AuditstreamError("INVALID_QUERY", "query.table must be a non-empty string");
  }
  if (!isPlainObject(query.recordId)) {
    throw new AuditstreamError("INVALID_QUERY", "query.recordId must be a JSON object");
  }

  const schema = query.schema ?? "auditstream";
  if (typeof schema !== "string" || !VALID_SCHEMA_PATTERN.test(schema)) {
    throw new AuditstreamError(
      "INVALID_QUERY",
      `query.schema must match ^[a-z_][a-z0-9_]*$ (got ${JSON.stringify(schema)})`,
    );
  }

  const limit = query.limit ?? DEFAULT_HISTORY_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_HISTORY_LIMIT
  ) {
    throw new AuditstreamError(
      "INVALID_QUERY",
      `query.limit must be an integer between 1 and ${MAX_HISTORY_LIMIT} (got ${String(limit)})`,
    );
  }

  let recordIdJson: string;
  try {
    recordIdJson = JSON.stringify(query.recordId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AuditstreamError(
      "INVALID_QUERY",
      `query.recordId is not JSON-serializable: ${detail}`,
    );
  }

  const sql =
    `SELECT ${HISTORY_SELECT_COLUMNS} ` +
    `FROM "${schema}"."changes" ` +
    `WHERE table_name = $1::text AND record_id = $2::jsonb ` +
    `ORDER BY occurred_at DESC, id DESC ` +
    `LIMIT $3::int`;

  const result = await exec(sql, [query.table, recordIdJson, limit]);
  const rows = Array.isArray(result)
    ? result
    : (result as { readonly rows: readonly Record<string, unknown>[] }).rows;
  return rows.map(rowToHistoryEntry);
}
