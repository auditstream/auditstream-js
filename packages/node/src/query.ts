import { AuditstreamError } from "./context.js";
import {
  type AuditHistoryQueryResult,
  type AuditOp,
  type EventSourceKind,
  extractQueryRows,
  HISTORY_SELECT_COLUMNS,
  type HistoryEntry,
  isPlainObject,
  type JsonObject,
  rowToHistoryEntry,
  serializeRecordIdJson,
  validateCalendarDate,
  validateFilterString,
  validateQueryBase,
} from "./history.js";
import { decodeBase64UrlUnpadded, encodeBase64UrlUnpadded } from "./transport.js";

/**
 * Maximum number of `op` entries accepted in a single `audit.query()` `op` array filter.
 */
export const MAX_QUERY_OPS: 20 = 20;

/**
 * Mutable primitive-only parameter array passed to an {@link AuditQueryExecutor}.
 *
 * Compatible with `pg` (`pool.query(text, values)`), `postgres.js` (`sql.unsafe(text, values)`),
 * `@neondatabase/serverless` (`sql.query(text, values)`), and Prisma
 * (`prisma.$queryRawUnsafe(text, ...values)`).
 */
export type AuditQueryValues = (string | number)[];

/**
 * Callback that executes one parameterized `SELECT` against `{schema}.changes` using the
 * application's own database connection (which holds `SELECT` on `auditstream.changes`).
 */
export type AuditQueryExecutor = (
  text: string,
  values: AuditQueryValues,
) => AuditHistoryQueryResult | PromiseLike<AuditHistoryQueryResult>;

/**
 * Closed filter and keyset-pagination options accepted by `audit.query()`.
 *
 * At least one bounding filter (`recordId`, `since`, or `until`) is required unless
 * `unbounded: true` is passed explicitly.
 */
export interface AuditQuery {
  /** Filter by audited table name (`table_name = $N::text`). */
  readonly table?: string | undefined;
  /** Filter by audited schema name (`schema_name = $N::text`). */
  readonly schemaName?: string | undefined;
  /** Filter by exact primary key or application event target (`record_id = $N::jsonb`). */
  readonly recordId?: JsonObject | undefined;
  /** Filter by actor identifier matching `actor->>'id'` or `actor->'onBehalfOf'->>'id'`. */
  readonly actor?: string | undefined;
  /** Filter by tenant identifier matching `actor->>'tenant'` or `actor->'onBehalfOf'->>'tenant'`. */
  readonly tenant?: string | undefined;
  /** Filter by event origin (`"db"` for triggers, `"app"` for `audit.log()`). */
  readonly source?: EventSourceKind | undefined;
  /** Filter by a single operation or up to 20 operations (`op = $N::text` or `op IN (...)`). */
  readonly op?: AuditOp | readonly AuditOp[] | undefined;
  /** Filter by operation prefix using `pg_catalog.starts_with(op, $N::text)` (never `LIKE`). */
  readonly opPrefix?: string | undefined;
  /** Inclusive lower bound on `occurred_at` (`occurred_at >= $N::timestamptz`). */
  readonly since?: Date | string | undefined;
  /** Exclusive upper bound on `occurred_at` (`occurred_at < $N::timestamptz`). */
  readonly until?: Date | string | undefined;
  /**
   * Audit schema name (defaults to `"auditstream"`).
   * Must match `^[a-z_][a-z0-9_]*$`; invalid schema names throw {@link AuditstreamError}
   * before any SQL is sent.
   */
  readonly schema?: string | undefined;
  /** Maximum number of rows to return per page (`1..=1000`, default `50`). */
  readonly limit?: number | undefined;
  /** Opaque keyset pagination cursor returned as `nextCursor` by a previous page. */
  readonly cursor?: string | undefined;
  /**
   * Explicitly allow a query with none of `recordId`, `since`, or `until`.
   * Defaults to `false` to prevent accidental unbounded cross-partition scans.
   */
  readonly unbounded?: boolean | undefined;
}

/**
 * Keyset-paginated page returned by `audit.query()`.
 */
export interface AuditQueryPage {
  /** Matching history rows for this page, ordered newest first (`occurred_at DESC, id DESC`). */
  readonly entries: readonly HistoryEntry[];
  /** Opaque cursor to pass as `query.cursor` for the next page, or `null` when no more rows exist. */
  readonly nextCursor: string | null;
  /** `true` when at least one older matching row exists beyond this page. */
  readonly hasMore: boolean;
}

const MAX_CURSOR_CHARS = 256;
const CURSOR_VERSION = 1;
const CURSOR_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{1,6}Z$/;
const BIGINT_DECIMAL_PATTERN = /^-?\d+$/;
const ISO_BOUND_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?(Z|[+-](?:0\d|1[0-5]):[0-5]\d))?$/;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface DecodedCursor {
  readonly occurredAt: string;
  readonly id: string;
}

interface ParsedTimestampBound {
  readonly sqlValue: string;
  readonly epochMicros: bigint;
}

function encodeCursor(occurredAt: string, id: string): string {
  const payload = JSON.stringify({ v: CURSOR_VERSION, t: occurredAt, i: id });
  return encodeBase64UrlUnpadded(utf8Encoder.encode(payload));
}

function isCursorTimestamp(value: unknown): value is string {
  const match = typeof value === "string" ? CURSOR_TIMESTAMP_PATTERN.exec(value) : null;
  return (
    match !== null && validateCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
  );
}

function isCursorId(value: unknown): value is string {
  if (typeof value !== "string" || !BIGINT_DECIMAL_PATTERN.test(value)) {
    return false;
  }
  const id = BigInt(value);
  return id >= -9_223_372_036_854_775_808n && id <= 9_223_372_036_854_775_807n;
}

function decodeCursor(raw: unknown): DecodedCursor {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AuditstreamError("INVALID_QUERY", "query.cursor must be a non-empty string");
  }
  const bytes = decodeBase64UrlUnpadded(raw, MAX_CURSOR_CHARS);
  if (bytes === null) {
    throw new AuditstreamError("INVALID_QUERY", "query.cursor is not a valid cursor token");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    throw new AuditstreamError("INVALID_QUERY", "query.cursor is not a valid cursor token");
  }

  if (
    !isPlainObject(parsed) ||
    parsed.v !== CURSOR_VERSION ||
    !isCursorTimestamp(parsed.t) ||
    !isCursorId(parsed.i)
  ) {
    throw new AuditstreamError("INVALID_QUERY", "query.cursor payload is invalid");
  }

  return { occurredAt: parsed.t, id: parsed.i };
}

function parseTimestampBound(raw: unknown, field: string): ParsedTimestampBound {
  if (raw instanceof Date) {
    const ms = raw.getTime();
    if (Number.isNaN(ms)) {
      throw new AuditstreamError("INVALID_QUERY", `${field} must be a valid Date`);
    }
    const year = raw.getUTCFullYear();
    if (year < 1 || year > 9999) {
      throw new AuditstreamError(
        "INVALID_QUERY",
        `${field} must have a UTC year between 0001 and 9999`,
      );
    }
    return { sqlValue: raw.toISOString(), epochMicros: BigInt(ms) * 1000n };
  }

  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AuditstreamError(
      "INVALID_QUERY",
      `${field} must be a valid Date or RFC 3339 timestamp string`,
    );
  }

  const match = ISO_BOUND_PATTERN.exec(raw);
  if (match === null) {
    throw new AuditstreamError(
      "INVALID_QUERY",
      `${field} must be an RFC 3339 timestamp or YYYY-MM-DD UTC date`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validateCalendarDate(year, month, day)) {
    throw new AuditstreamError("INVALID_QUERY", `${field} contains an invalid calendar date`);
  }

  const hourStr = match[4];
  if (hourStr === undefined) {
    const utcDate = `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
    return {
      sqlValue: utcDate,
      epochMicros: BigInt(Date.parse(utcDate)) * 1000n,
    };
  }

  const minuteStr = match[5] ?? "00";
  const secondStr = match[6] ?? "00";
  const fracStr = match[7] ?? "";
  const tzStr = match[8] ?? "Z";
  const wholeSecIso = `${match[1]}-${match[2]}-${match[3]}T${hourStr}:${minuteStr}:${secondStr}${tzStr}`;
  const wholeSecMs = Date.parse(wholeSecIso);
  if (Number.isNaN(wholeSecMs)) {
    throw new AuditstreamError("INVALID_QUERY", `${field} is not a valid timestamp`);
  }

  const fracMicros = BigInt(fracStr.padEnd(6, "0"));
  return {
    sqlValue: raw,
    epochMicros: BigInt(wholeSecMs) * 1000n + fracMicros,
  };
}

function validateOps(raw: unknown): readonly string[] {
  if (typeof raw === "string") {
    return [validateFilterString(raw, "query.op")];
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUERY_OPS) {
    throw new AuditstreamError(
      "INVALID_QUERY",
      `query.op must be a non-empty string or an array of 1 to ${MAX_QUERY_OPS} non-empty strings`,
    );
  }
  return raw.map((item) => validateFilterString(item, "query.op[]"));
}

function pushOpPredicates(
  ops: readonly string[],
  predicates: string[],
  bind: (v: string | number) => string,
): void {
  if (ops.length === 1) {
    const first = ops[0] ?? "";
    predicates.push(`op = ${bind(first)}::text`);
    return;
  }
  const placeholders = ops.map((op) => `${bind(op)}::text`).join(", ");
  predicates.push(`op IN (${placeholders})`);
}

function pushTimeAndCursorPredicates(
  query: AuditQuery,
  predicates: string[],
  bind: (v: string | number) => string,
): void {
  const since =
    query.since !== undefined ? parseTimestampBound(query.since, "query.since") : undefined;
  const until =
    query.until !== undefined ? parseTimestampBound(query.until, "query.until") : undefined;
  if (since !== undefined && until !== undefined && since.epochMicros >= until.epochMicros) {
    throw new AuditstreamError("INVALID_QUERY", "query.until must be strictly after query.since");
  }
  if (since !== undefined) {
    predicates.push(`occurred_at >= ${bind(since.sqlValue)}::timestamptz`);
  }
  if (until !== undefined) {
    predicates.push(`occurred_at < ${bind(until.sqlValue)}::timestamptz`);
  }
  if (query.cursor !== undefined) {
    const cur = decodeCursor(query.cursor);
    const tsParam = bind(cur.occurredAt);
    const idParam = bind(cur.id);
    // Standalone `occurred_at <=` lets PostgreSQL prune newer monthly partitions while
    // `(occurred_at, id) <` provides lossless keyset tie-breaking.
    predicates.push(
      `occurred_at <= ${tsParam}::timestamptz AND (occurred_at, id) < (${tsParam}::timestamptz, ${idParam}::bigint)`,
    );
  }
}

function buildPredicates(query: AuditQuery, values: AuditQueryValues): string[] {
  const predicates: string[] = [];
  const bind = (value: string | number): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (query.schemaName !== undefined) {
    predicates.push(
      `schema_name = ${bind(validateFilterString(query.schemaName, "query.schemaName"))}::text`,
    );
  }
  if (query.table !== undefined) {
    predicates.push(`table_name = ${bind(validateFilterString(query.table, "query.table"))}::text`);
  }
  if (query.recordId !== undefined) {
    predicates.push(`record_id = ${bind(serializeRecordIdJson(query.recordId))}::jsonb`);
  }
  if (query.actor !== undefined) {
    const p = bind(validateFilterString(query.actor, "query.actor"));
    predicates.push(`(actor->>'id' = ${p}::text OR actor->'onBehalfOf'->>'id' = ${p}::text)`);
  }
  if (query.tenant !== undefined) {
    const p = bind(validateFilterString(query.tenant, "query.tenant"));
    predicates.push(
      `(actor->>'tenant' = ${p}::text OR actor->'onBehalfOf'->>'tenant' = ${p}::text)`,
    );
  }
  if (query.source !== undefined) {
    if (query.source !== "db" && query.source !== "app") {
      throw new AuditstreamError("INVALID_QUERY", 'query.source must be "db" or "app"');
    }
    predicates.push(`source = ${bind(query.source)}::text`);
  }
  if (query.op !== undefined) {
    pushOpPredicates(validateOps(query.op), predicates, bind);
  }
  if (query.opPrefix !== undefined) {
    const p = bind(validateFilterString(query.opPrefix, "query.opPrefix"));
    predicates.push(`pg_catalog.starts_with(op, ${p}::text)`);
  }

  pushTimeAndCursorPredicates(query, predicates, bind);
  return predicates;
}

/**
 * Queries `{schema}.changes` with validated filters and lossless microsecond keyset pagination,
 * ordered newest first (`occurred_at DESC, id DESC`).
 *
 * - Supports both database trigger rows (`source: "db"`) and application events logged via
 *   `audit.log()` (`source: "app"`, `table_name IS NULL`).
 * - Requires at least one bounding filter (`recordId`, `since`, or `until`) unless
 *   `unbounded: true` is passed explicitly.
 * - Fetches `limit + 1` rows (no `count(*)`) and emits `occurred_at <= $ts::timestamptz AND
 *   (occurred_at, id) < ($ts::timestamptz, $id::bigint)` so PostgreSQL prunes monthly partitions.
 * - **Backend-only API:** Enforce authentication and tenant authorization on the server, and
 *   project {@link HistoryEntry} rows to an allowlisted client DTO before returning data to browsers.
 */
export async function queryHistory(
  exec: AuditQueryExecutor,
  query: AuditQuery,
): Promise<AuditQueryPage> {
  const { schema, limit } = validateQueryBase(exec, query);

  if (query.unbounded !== undefined && typeof query.unbounded !== "boolean") {
    throw new AuditstreamError("INVALID_QUERY", "query.unbounded must be a boolean");
  }

  const hasBound =
    query.recordId !== undefined || query.since !== undefined || query.until !== undefined;
  if (!hasBound && query.unbounded !== true) {
    throw new AuditstreamError(
      "INVALID_QUERY",
      "audit.query() requires at least one bounding filter (recordId, since, or until) or explicit unbounded: true",
    );
  }

  const values: AuditQueryValues = [];
  const predicates = buildPredicates(query, values);

  values.push(limit + 1);
  const limitParam = `$${values.length}`;
  const whereClause = predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
  const sql =
    `SELECT ${HISTORY_SELECT_COLUMNS} ` +
    `FROM "${schema}"."changes"${whereClause} ` +
    `ORDER BY occurred_at DESC, id DESC ` +
    `LIMIT ${limitParam}::int`;

  const result = await exec(sql, values);
  const rows = extractQueryRows(result);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const entries = pageRows.map(rowToHistoryEntry);
  const last = entries[entries.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(last.occurred_at, last.id) : null;

  return { entries, nextCursor, hasMore };
}
