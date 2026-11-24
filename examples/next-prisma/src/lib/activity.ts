import {
  type Actor,
  type ActorType,
  type AuditQuery,
  AuditstreamError,
  audit,
  type EventSourceKind,
  type HistoryEntry,
  type JsonObject,
  type JsonValue,
} from "@auditstream/node";
import { getPool } from "./prisma";

/** Default page size returned by the Activity Feed BFF. */
export const DEFAULT_ACTIVITY_LIMIT = 20;

/** Hard upper bound on page size enforced by the Activity Feed BFF. */
export const MAX_ACTIVITY_LIMIT = 100;

/** Default rolling lookback window when neither `since` nor `until` is provided. */
export const DEFAULT_ACTIVITY_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Explicit per-table allowlist of columns that may be summarized for browser clients.
 * Any column outside this allowlist is never projected into `changedFields` or `summary`.
 */
const ALLOWED_TABLE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  invoice: new Set(["status", "total"]),
};

/**
 * Demo server-side user directory resolving opaque actor IDs (`spec/actor.md` IDs-only rule)
 * into display labels.
 *
 * In production, replace {@link resolveActorNames} with a single batched lookup against your
 * application user store (for example `prisma.user.findMany({ where: { id: { in: ids } } })`).
 */
const DEMO_ACTOR_DIRECTORY: Readonly<Record<string, string>> = {
  alice: "Alice Rivera",
  bob: "Bob Chen",
  carol: "Carol Diaz",
  "dave-action": "Dave Patel",
  usr_42: "Taylor Morgan",
  bot_billing: "Billing Assistant",
};

/** Client-safe representation of an actor with a server-resolved display name. */
export interface ActivityActorDto {
  readonly id: string;
  readonly type: ActorType;
  readonly displayName: string;
  readonly onBehalfOf?: {
    readonly id: string;
    readonly type: ActorType;
    readonly displayName: string;
  };
}

/**
 * Allowlisted Activity Feed item safe to send to browsers.
 *
 * Intentionally omits internal PostgreSQL and audit-transport metadata (`id`, `xact_id`,
 * `table_oid`, `db_user`, `actor_source`, `schema_version`, raw `before`/`after` images,
 * and `context` such as client IP addresses).
 */
export interface ActivityFeedItem {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly source: EventSourceKind;
  readonly action: string;
  readonly entity: string;
  readonly recordId: string | null;
  readonly changedFields: readonly string[];
  readonly summary: string;
  readonly actor: ActivityActorDto | null;
}

/** Keyset-paginated Activity Feed response (zero `count(*)` queries). */
export interface ActivityFeedPage {
  readonly items: readonly ActivityFeedItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Validated server-side query options accepted by {@link queryActivityFeed}. */
export interface ActivityFeedQueryOptions {
  readonly source?: EventSourceKind | undefined;
  readonly opPrefix?: string | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  /**
   * Server-derived tenant identifier (from a verified session/JWT, never from URL query params).
   *
   * Note: `actor.tenant` filters self-asserted actor metadata only and omits unscoped writes
   * (`actor IS NULL`). For strict multi-tenant authorization, combine with row ownership or RLS.
   */
  readonly tenant?: string | undefined;
}

function formatFallbackActorName(type: ActorType, id: string): string {
  switch (type) {
    case "user":
      return `User ${id}`;
    case "ai_agent":
      return `AI agent ${id}`;
    case "service":
      return `Service ${id}`;
    case "system":
      return `System ${id}`;
    default:
      return `${type} ${id}`;
  }
}

/**
 * Batch-resolves opaque actor IDs on the server so actor names and emails are never stored
 * inside `auditstream.changes.actor` (`spec/actor.md`).
 */
export async function resolveActorNames(
  actorIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const uniqueIds = new Set(actorIds);
  const resolved = new Map<string, string>();
  for (const id of uniqueIds) {
    const name = DEMO_ACTOR_DIRECTORY[id];
    if (name !== undefined) {
      resolved.set(id, name);
    }
  }
  return resolved;
}

function projectActor(
  actor: Actor | null,
  names: ReadonlyMap<string, string>,
): ActivityActorDto | null {
  if (actor === null) {
    return null;
  }
  const displayName = names.get(actor.id) ?? formatFallbackActorName(actor.type, actor.id);
  const delegated = actor.onBehalfOf;
  if (!delegated) {
    return {
      id: actor.id,
      type: actor.type,
      displayName,
    };
  }
  return {
    id: actor.id,
    type: actor.type,
    displayName,
    onBehalfOf: {
      id: delegated.id,
      type: delegated.type,
      displayName: names.get(delegated.id) ?? formatFallbackActorName(delegated.type, delegated.id),
    },
  };
}

function formatScalar(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function projectRecordId(recordId: JsonObject | null): string | null {
  if (recordId === null) {
    return null;
  }
  const idVal = formatScalar(recordId.id);
  if (idVal !== null) {
    return idVal;
  }
  return null;
}

function deriveEntity(entry: HistoryEntry): string {
  if (entry.source === "db") {
    return entry.table_name ?? "record";
  }
  const dotIndex = entry.op.indexOf(".");
  return dotIndex > 0 ? entry.op.slice(0, dotIndex) : "app";
}

function projectChangedFields(entry: HistoryEntry): readonly string[] {
  if (entry.source !== "db" || !entry.table_name || !entry.changed) {
    return [];
  }
  const allowed = ALLOWED_TABLE_FIELDS[entry.table_name];
  if (!allowed) {
    return [];
  }
  return entry.changed.filter((field) => allowed.has(field)).sort();
}

function summarizeDbEvent(
  entry: HistoryEntry,
  entity: string,
  recordId: string | null,
  changedFields: readonly string[],
): string {
  const ref = recordId !== null ? `${entity} #${recordId}` : entity;
  const allowed = entry.table_name ? ALLOWED_TABLE_FIELDS[entry.table_name] : undefined;

  if (entry.op === "INSERT") {
    const details = formatAllowedSnapshot(entry.after, allowed);
    return details ? `Created ${ref} (${details})` : `Created ${ref}`;
  }

  if (entry.op === "UPDATE") {
    const diffs: string[] = [];
    for (const field of changedFields) {
      const beforeVal = formatScalar(entry.before?.[field]);
      const afterVal = formatScalar(entry.after?.[field]);
      if (beforeVal !== null && afterVal !== null) {
        diffs.push(`${field}: ${beforeVal} → ${afterVal}`);
      } else if (afterVal !== null) {
        diffs.push(`${field}: ${afterVal}`);
      }
    }
    return diffs.length > 0 ? `Updated ${ref} (${diffs.join(", ")})` : `Updated ${ref}`;
  }

  if (entry.op === "DELETE") {
    return `Deleted ${ref}`;
  }

  if (entry.op === "TRUNCATE") {
    return `Truncated ${entity}`;
  }

  return `${entry.op} on ${ref}`;
}

function formatAllowedSnapshot(
  snapshot: JsonObject | null,
  allowed: ReadonlySet<string> | undefined,
): string {
  if (!snapshot || !allowed) {
    return "";
  }
  const parts: string[] = [];
  for (const field of allowed) {
    const val = formatScalar(snapshot[field]);
    if (val !== null) {
      parts.push(`${field}: ${val}`);
    }
  }
  return parts.join(", ");
}

function summarizeAppEvent(entry: HistoryEntry, entity: string, recordId: string | null): string {
  const ref = recordId !== null ? `${entity} #${recordId}` : entity;
  if (entry.op === "invoice.exported") {
    const format = formatScalar(entry.after?.format);
    return format ? `Exported ${ref} as ${format}` : `Exported ${ref}`;
  }
  return recordId !== null ? `${entry.op} (${ref})` : entry.op;
}

/**
 * Projects a raw {@link HistoryEntry} into a minimal, allowlisted {@link ActivityFeedItem}.
 * Never forwards raw `HistoryEntry` objects directly to browser clients.
 */
export function toActivityFeedItem(
  entry: HistoryEntry,
  names: ReadonlyMap<string, string>,
): ActivityFeedItem {
  const entity = deriveEntity(entry);
  const recordId = projectRecordId(entry.record_id);
  const changedFields = projectChangedFields(entry);
  const summary =
    entry.source === "db"
      ? summarizeDbEvent(entry, entity, recordId, changedFields)
      : summarizeAppEvent(entry, entity, recordId);

  return {
    eventId: entry.event_id,
    occurredAt: entry.occurred_at,
    source: entry.source,
    action: entry.op,
    entity,
    recordId,
    changedFields,
    summary,
    actor: projectActor(entry.actor, names),
  };
}

/**
 * Queries the Activity Feed via `audit.query()` using keyset pagination (`nextCursor` / `hasMore`,
 * zero `count(*)` queries), enforces a default lookback window for partition pruning, resolves
 * opaque actor IDs in a single server-side batch, and projects rows to allowlisted client DTOs.
 */
export async function queryActivityFeed(
  options: ActivityFeedQueryOptions = {},
): Promise<ActivityFeedPage> {
  const limit = options.limit ?? DEFAULT_ACTIVITY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_LIMIT) {
    throw new AuditstreamError(
      "INVALID_QUERY",
      `limit must be an integer between 1 and ${MAX_ACTIVITY_LIMIT}`,
    );
  }

  const defaultSince =
    options.since === undefined && options.until === undefined
      ? new Date(Date.now() - DEFAULT_ACTIVITY_WINDOW_DAYS * MS_PER_DAY)
      : undefined;

  const query: AuditQuery = {
    ...(options.source !== undefined ? { source: options.source } : {}),
    ...(options.opPrefix !== undefined ? { opPrefix: options.opPrefix } : {}),
    ...(options.since !== undefined
      ? { since: options.since }
      : defaultSince !== undefined
        ? { since: defaultSince }
        : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.tenant !== undefined ? { tenant: options.tenant } : {}),
    limit,
  };

  const pool = getPool();
  const page = await audit.query((text, values) => pool.query(text, values), query);

  const actorIds: string[] = [];
  for (const entry of page.entries) {
    if (entry.actor) {
      actorIds.push(entry.actor.id);
      if (entry.actor.onBehalfOf) {
        actorIds.push(entry.actor.onBehalfOf.id);
      }
    }
  }
  const names = await resolveActorNames(actorIds);

  return {
    items: page.entries.map((entry) => toActivityFeedItem(entry, names)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}
