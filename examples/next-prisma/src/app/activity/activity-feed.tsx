"use client";

import { type CSSProperties, type FormEvent, type ReactNode, useId, useState } from "react";
import type { ActivityFeedItem, ActivityFeedPage } from "../../lib/activity";

type SourceFilter = "" | "db" | "app";
type WindowPreset = "30d" | "7d" | "24h" | "custom";

interface AppliedFilters {
  readonly source: SourceFilter;
  readonly opPrefix: string;
  readonly since: string;
  readonly until: string;
}

interface ActivityFeedProps {
  readonly initialPage: ActivityFeedPage;
}

const EMPTY_FILTERS: AppliedFilters = {
  source: "",
  opPrefix: "",
  since: "",
  until: "",
};

const STYLES: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
    maxWidth: "56rem",
  },
  form: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
    alignItems: "flex-end",
    padding: "0.875rem",
    border: "1px solid #d4d4d8",
    borderRadius: "0.5rem",
    backgroundColor: "#fafafa",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    fontSize: "0.875rem",
  },
  input: {
    padding: "0.375rem 0.5rem",
    border: "1px solid #a1a1aa",
    borderRadius: "0.375rem",
    fontSize: "0.875rem",
    backgroundColor: "#ffffff",
  },
  buttonPrimary: {
    padding: "0.45rem 0.85rem",
    border: "1px solid #18181b",
    borderRadius: "0.375rem",
    backgroundColor: "#18181b",
    color: "#ffffff",
    fontSize: "0.875rem",
    cursor: "pointer",
  },
  buttonSecondary: {
    padding: "0.45rem 0.85rem",
    border: "1px solid #a1a1aa",
    borderRadius: "0.375rem",
    backgroundColor: "#ffffff",
    color: "#18181b",
    fontSize: "0.875rem",
    cursor: "pointer",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: "0.625rem",
  },
  card: {
    border: "1px solid #e4e4e7",
    borderRadius: "0.5rem",
    padding: "0.875rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  cardHeader: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
  },
  badgeRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  badgeDb: {
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "0.125rem 0.45rem",
    borderRadius: "9999px",
    backgroundColor: "#e0f2fe",
    color: "#075985",
  },
  badgeApp: {
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "0.125rem 0.45rem",
    borderRadius: "9999px",
    backgroundColor: "#f3e8ff",
    color: "#6b21a8",
  },
  meta: {
    fontSize: "0.8125rem",
    color: "#52525b",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
  },
  fieldChip: {
    fontSize: "0.75rem",
    padding: "0.0625rem 0.4rem",
    borderRadius: "0.25rem",
    backgroundColor: "#f4f4f5",
    color: "#27272a",
  },
  error: {
    padding: "0.75rem",
    border: "1px solid #fecaca",
    borderRadius: "0.375rem",
    backgroundColor: "#fef2f2",
    color: "#991b1b",
    fontSize: "0.875rem",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: "0.25rem",
    fontSize: "0.875rem",
    color: "#52525b",
  },
};

function computeWindowSince(preset: Exclude<WindowPreset, "custom">): string {
  const hours = preset === "24h" ? 24 : preset === "7d" ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function buildSearchParams(filters: AppliedFilters, cursor?: string): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.source) {
    params.set("source", filters.source);
  }
  if (filters.opPrefix.trim().length > 0) {
    params.set("opPrefix", filters.opPrefix.trim());
  }
  if (filters.since.trim().length > 0) {
    params.set("since", filters.since.trim());
  }
  if (filters.until.trim().length > 0) {
    params.set("until", filters.until.trim());
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  return params;
}

function formatActorLabel(item: ActivityFeedItem): string {
  if (!item.actor) {
    return "System / unscoped";
  }
  if (item.actor.onBehalfOf) {
    return `${item.actor.displayName} (on behalf of ${item.actor.onBehalfOf.displayName})`;
  }
  return item.actor.displayName;
}

function appendUniqueItems(
  existing: readonly ActivityFeedItem[],
  incoming: readonly ActivityFeedItem[],
): readonly ActivityFeedItem[] {
  const seen = new Set(existing.map((item) => item.eventId));
  const merged = [...existing];
  for (const item of incoming) {
    if (!seen.has(item.eventId)) {
      seen.add(item.eventId);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Self-contained, copy-pasteable Activity Feed view powered by `GET /api/activity`
 * (`audit.query()`). Uses keyset pagination (`nextCursor` / `hasMore`) with zero `count(*)`
 * queries and renders allowlisted client DTOs only.
 */
export function ActivityFeed({ initialPage }: ActivityFeedProps): ReactNode {
  const sourceId = useId();
  const opPrefixId = useId();
  const windowId = useId();
  const sinceId = useId();
  const untilId = useId();

  const [items, setItems] = useState<readonly ActivityFeedItem[]>(initialPage.items);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor);
  const [hasMore, setHasMore] = useState<boolean>(initialPage.hasMore);

  const [source, setSource] = useState<SourceFilter>("");
  const [opPrefix, setOpPrefix] = useState<string>("");
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("30d");
  const [customSince, setCustomSince] = useState<string>("");
  const [customUntil, setCustomUntil] = useState<string>("");
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters>(EMPTY_FILTERS);

  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPage(filters: AppliedFilters, cursor?: string): Promise<ActivityFeedPage> {
    const query = buildSearchParams(filters, cursor).toString();
    const url = query.length > 0 ? `/api/activity?${query}` : "/api/activity";
    const response = await fetch(url, { cache: "no-store" });
    const payload = (await response.json()) as ActivityFeedPage | { readonly error?: string };
    if (!response.ok) {
      const message =
        "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload as ActivityFeedPage;
  }

  async function handleApplyFilters(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextFilters: AppliedFilters = {
      source,
      opPrefix: opPrefix.trim(),
      since: windowPreset === "custom" ? customSince.trim() : computeWindowSince(windowPreset),
      until: windowPreset === "custom" ? customUntil.trim() : "",
    };

    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(nextFilters);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setAppliedFilters(nextFilters);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity feed");
    } finally {
      setLoading(false);
    }
  }

  async function handleReset(): Promise<void> {
    setSource("");
    setOpPrefix("");
    setWindowPreset("30d");
    setCustomSince("");
    setCustomUntil("");
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage(EMPTY_FILTERS);
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
      setAppliedFilters(EMPTY_FILTERS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset activity feed");
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadMore(): Promise<void> {
    if (!hasMore || nextCursor === null || loadingMore) {
      return;
    }
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchPage(appliedFilters, nextCursor);
      setItems((prev) => appendUniqueItems(prev, page.items));
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more events");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section style={STYLES.container} aria-label="Activity Feed">
      <form onSubmit={handleApplyFilters} style={STYLES.form}>
        <div style={STYLES.field}>
          <label htmlFor={sourceId}>Source</label>
          <select
            id={sourceId}
            value={source}
            onChange={(event) => setSource(event.target.value as SourceFilter)}
            style={STYLES.input}
          >
            <option value="">All events</option>
            <option value="db">Database changes (db)</option>
            <option value="app">Application events (app)</option>
          </select>
        </div>

        <div style={STYLES.field}>
          <label htmlFor={opPrefixId}>Action prefix</label>
          <input
            id={opPrefixId}
            type="text"
            placeholder="e.g. invoice. or UPDATE"
            value={opPrefix}
            onChange={(event) => setOpPrefix(event.target.value)}
            style={STYLES.input}
          />
        </div>

        <div style={STYLES.field}>
          <label htmlFor={windowId}>Date window</label>
          <select
            id={windowId}
            value={windowPreset}
            onChange={(event) => setWindowPreset(event.target.value as WindowPreset)}
            style={STYLES.input}
          >
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom UTC dates</option>
          </select>
        </div>

        {windowPreset === "custom" ? (
          <>
            <div style={STYLES.field}>
              <label htmlFor={sinceId}>Since (UTC)</label>
              <input
                id={sinceId}
                type="date"
                value={customSince}
                onChange={(event) => setCustomSince(event.target.value)}
                style={STYLES.input}
              />
            </div>
            <div style={STYLES.field}>
              <label htmlFor={untilId}>Until (UTC, exclusive)</label>
              <input
                id={untilId}
                type="date"
                value={customUntil}
                onChange={(event) => setCustomUntil(event.target.value)}
                style={STYLES.input}
              />
            </div>
          </>
        ) : null}

        <button type="submit" disabled={loading} style={STYLES.buttonPrimary}>
          {loading ? "Loading…" : "Apply filters"}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={handleReset}
          style={STYLES.buttonSecondary}
        >
          Reset
        </button>
      </form>

      {error ? (
        <div role="alert" style={STYLES.error}>
          {error}
        </div>
      ) : null}

      {items.length === 0 ? (
        <p>No activity events match the current filters.</p>
      ) : (
        <ol style={STYLES.list}>
          {items.map((item) => (
            <li key={item.eventId} style={STYLES.card}>
              <div style={STYLES.cardHeader}>
                <div style={STYLES.badgeRow}>
                  <span style={item.source === "app" ? STYLES.badgeApp : STYLES.badgeDb}>
                    {item.source}
                  </span>
                  <strong>{item.action}</strong>
                </div>
                <time
                  dateTime={item.occurredAt}
                  style={{ fontSize: "0.8125rem", color: "#52525b" }}
                >
                  {item.occurredAt}
                </time>
              </div>
              <div>{item.summary}</div>
              <div style={STYLES.meta}>
                <span>Actor: {formatActorLabel(item)}</span>
                <span>Entity: {item.entity}</span>
                {item.changedFields.length > 0 ? (
                  <span>
                    Changed:{" "}
                    {item.changedFields.map((field) => (
                      <code key={field} style={{ ...STYLES.fieldChip, marginRight: "0.25rem" }}>
                        {field}
                      </code>
                    ))}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      <div style={STYLES.footer}>
        <span>
          Showing {items.length} {items.length === 1 ? "event" : "events"}
          {hasMore ? " (more available)" : " — end of range"}
        </span>
        {hasMore && nextCursor !== null ? (
          <button
            type="button"
            disabled={loadingMore}
            onClick={handleLoadMore}
            style={STYLES.buttonSecondary}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
