import { AuditstreamError, audit, type HistoryEntry } from "@auditstream/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordedQueries, mockPrismaUpdate } = vi.hoisted(() => ({
  recordedQueries: [] as Array<{ readonly text: string; readonly values: readonly unknown[] }>,
  mockPrismaUpdate: vi.fn(async (_args?: unknown) => ({
    id: 1,
    status: "paid",
    total: { toString: () => "10.00" },
  })),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-demo-user": "alice" })),
}));

vi.mock("../src/lib/prisma", () => ({
  getPool: () => ({
    query: vi.fn(async (text: string, values: unknown[]) => {
      recordedQueries.push({ text, values });
      return { rows: [] };
    }),
  }),
  getPrisma: () => ({
    invoice: {
      update: mockPrismaUpdate,
    },
  }),
}));

import { updateInvoiceStatus, updateInvoiceStatusForm } from "../src/app/actions";
import {
  DEFAULT_ACTIVITY_WINDOW_DAYS,
  MAX_ACTIVITY_WINDOW_DAYS,
  queryActivityFeed,
  resolveActorNames,
  toActivityFeedItem,
} from "../src/lib/activity";
import {
  MAX_DEMO_HEADER_BYTES,
  resolveAuditContext,
  resolveDemoActor,
  resolveDemoTenant,
} from "../src/lib/actor";

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "1",
    event_id: "01960000-0000-7000-8000-000000000001",
    occurred_at: "2026-11-26T12:00:00.000000Z",
    xact_id: "100",
    source: "db",
    schema_name: "public",
    table_name: "invoice",
    table_oid: 16384,
    op: "UPDATE",
    record_id: { id: 42 },
    before: { id: 42, status: "draft", total: "10.00" },
    after: { id: 42, status: "paid", total: "10.00" },
    changed: ["status"],
    actor: { type: "user", id: "alice" },
    context: null,
    actor_source: "comment",
    db_user: "app",
    schema_version: 1,
    ...overrides,
  };
}

describe("examples/next-prisma hardening (#94)", () => {
  beforeEach(() => {
    recordedQueries.length = 0;
    mockPrismaUpdate.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles Object.prototype keys in resolveActorNames() and toActivityFeedItem() without returning functions or throwing", async () => {
    const protoKeys = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"];
    const names = await resolveActorNames(["alice", ...protoKeys]);

    expect(names.get("alice")).toBe("Alice Rivera");
    for (const key of protoKeys) {
      expect(names.has(key)).toBe(false);
      expect(names.get(key)).toBeUndefined();
    }

    for (const key of protoKeys) {
      const updateItem = toActivityFeedItem(
        makeEntry({
          table_name: key,
          actor: {
            type: "ai_agent",
            id: key,
            onBehalfOf: { type: "user", id: "constructor" },
          },
        }),
        names,
      );

      expect(updateItem.changedFields).toEqual([]);
      expect(updateItem.actor?.displayName).toBe(`AI agent ${key}`);
      expect(typeof updateItem.actor?.displayName).toBe("string");
      expect(updateItem.actor?.onBehalfOf?.displayName).toBe("User constructor");
      expect(() => JSON.stringify(updateItem)).not.toThrow();

      // INSERT with changed: null exercises summarizeDbEvent's own ALLOWED_TABLE_FIELDS.get() path.
      const insertItem = toActivityFeedItem(
        makeEntry({
          op: "INSERT",
          changed: null,
          before: null,
          table_name: key,
          actor: { type: "user", id: key },
        }),
        names,
      );
      expect(insertItem.summary).toBe(`Created ${key} #42`);
      expect(insertItem.actor?.displayName).toBe(`User ${key}`);
    }
  });

  it("enforces bounded date windows across YYYY-MM-DD and RFC 3339 timestamps (since-only, until-only, and both)", async () => {
    vi.useFakeTimers();
    const fixedNow = new Date("2026-11-27T00:00:00.000Z");
    vi.setSystemTime(fixedNow);

    // 1. Only `until` far in the future must still attach a bounded 30-day `since` lower bound.
    await queryActivityFeed({ until: "2099-01-01" });
    expect(recordedQueries).toHaveLength(1);
    const onlyUntilQuery = recordedQueries[0];
    expect(onlyUntilQuery?.text).toContain("occurred_at >=");
    expect(onlyUntilQuery?.text).toContain("occurred_at <");
    const derivedMs = Date.parse(String(onlyUntilQuery?.values[0]));
    const untilMs = Date.parse("2099-01-01T00:00:00Z");
    expect(untilMs - derivedMs).toBe(DEFAULT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // 2. Valid recent past RFC 3339 `since`-only queries (UI presets: 30d and exact 90d boundary) succeed.
    recordedQueries.length = 0;
    const thirtyDaysAgoIso = new Date(
      fixedNow.getTime() - DEFAULT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const exactMaxDaysAgoIso = new Date(
      fixedNow.getTime() - MAX_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    await queryActivityFeed({ since: thirtyDaysAgoIso });
    await queryActivityFeed({ since: exactMaxDaysAgoIso });
    expect(recordedQueries).toHaveLength(2);

    // 3. Exact 90-day RFC 3339 span with microseconds and mixed timezone offsets succeeds.
    recordedQueries.length = 0;
    await queryActivityFeed({
      since: "2025-01-01T00:00:00.000000Z",
      until: "2025-04-01T00:00:00.000000Z",
    });
    await queryActivityFeed({
      since: "2025-01-01T02:00:00+02:00",
      until: "2025-04-01T00:00:00Z",
    });
    expect(recordedQueries).toHaveLength(2);

    // 4. Future `since` alone prunes all historical partitions and succeeds.
    recordedQueries.length = 0;
    await queryActivityFeed({ since: "2099-01-01" });
    expect(recordedQueries).toHaveLength(1);

    // 5. All oversized, inverted, or malformed date bounds reject with INVALID_QUERY before querying Postgres.
    recordedQueries.length = 0;
    const oneMsPastMaxIso = new Date(
      fixedNow.getTime() - MAX_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1,
    ).toISOString();
    await expect(queryActivityFeed({ since: "0001-01-01" })).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    await expect(queryActivityFeed({ since: oneMsPastMaxIso })).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    await expect(
      queryActivityFeed({
        since: "2025-01-01T00:00:00.000000Z",
        until: "2025-04-01T00:00:00.000001Z",
      }),
    ).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    await expect(
      queryActivityFeed({
        since: "2025-01-01T00:00:00Z",
        until: "2025-04-01T00:00:00-01:00",
      }),
    ).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    await expect(
      queryActivityFeed({ since: "2025-01-01", until: "2026-11-01" }),
    ).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    await expect(
      queryActivityFeed({ since: "2026-11-10", until: "2026-11-01" }),
    ).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    await expect(queryActivityFeed({ until: "2026-02-30" })).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    await expect(queryActivityFeed({ until: "0001-01-01" })).rejects.toMatchObject({
      name: "AuditstreamError",
      code: "INVALID_QUERY",
    });
    expect(recordedQueries).toHaveLength(0);
  });

  it("validates id and status at runtime in updateInvoiceStatus() and updateInvoiceStatusForm()", async () => {
    await expect(updateInvoiceStatus(0, "paid")).rejects.toThrow();
    await expect(updateInvoiceStatus(-5, "paid")).rejects.toThrow();
    await expect(updateInvoiceStatus(1.5, "paid")).rejects.toThrow();
    await expect(updateInvoiceStatus(Number.NaN, "paid")).rejects.toThrow();
    await expect(updateInvoiceStatus(2_147_483_648, "paid")).rejects.toThrow();
    await expect(updateInvoiceStatus(1, "   ")).rejects.toThrow();
    await expect(updateInvoiceStatus(1, "x".repeat(65))).rejects.toThrow();
    await expect(updateInvoiceStatus(1, "bad\u0000status")).rejects.toThrow();
    await expect(updateInvoiceStatus(1, "bad\uD800surrogate")).rejects.toThrow();
    await expect(updateInvoiceStatus("1" as unknown as number, "paid")).rejects.toThrow();
    await expect(updateInvoiceStatus(1, 123 as unknown as string)).rejects.toThrow();
    expect(mockPrismaUpdate).not.toHaveBeenCalled();

    // Form wrapper safely handles non-FormData RPC payloads, File entries, non-digit id suffixes, and oversized statuses.
    await updateInvoiceStatusForm(undefined as unknown as FormData);
    await updateInvoiceStatusForm(null as unknown as FormData);
    await updateInvoiceStatusForm({} as unknown as FormData);

    const fileIdForm = new FormData();
    fileIdForm.set("id", new File(["1"], "id.txt"));
    fileIdForm.set("status", "paid");
    await updateInvoiceStatusForm(fileIdForm);

    const fileStatusForm = new FormData();
    fileStatusForm.set("id", "1");
    fileStatusForm.set("status", new File(["paid"], "status.txt"));
    await updateInvoiceStatusForm(fileStatusForm);

    const badForm1 = new FormData();
    badForm1.set("id", "12abc");
    badForm1.set("status", "paid");
    await updateInvoiceStatusForm(badForm1);

    const badForm2 = new FormData();
    badForm2.set("id", "1");
    badForm2.set("status", "x".repeat(65));
    await updateInvoiceStatusForm(badForm2);
    expect(mockPrismaUpdate).not.toHaveBeenCalled();

    // Valid call (including valid surrogate-pair emoji) trims status and forwards to Prisma.
    const result = await updateInvoiceStatus(1, "  paid 😀  ");
    expect(result).toEqual({ id: 1, status: "paid", total: "10.00" });
    expect(mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "paid 😀" },
    });
  });

  it("bounds x-demo-user and x-demo-tenant by serialized JSON UTF-8 bytes and rejects control chars or lone surrogates", async () => {
    expect(MAX_DEMO_HEADER_BYTES).toBe(128);

    const valid = new Headers({
      "x-demo-user": "  alice  ",
      "x-demo-tenant": "  org_acme  ",
    });
    expect(resolveDemoActor(valid)).toEqual({
      type: "user",
      id: "alice",
      tenant: "org_acme",
    });
    expect(resolveDemoTenant(valid)).toBe("org_acme");

    // Prototype-key IDs remain valid printable strings (safe now that activity.ts uses Map).
    expect(resolveDemoActor(new Headers({ "x-demo-user": "toString" }))).toEqual({
      type: "user",
      id: "toString",
    });

    // Oversized ASCII, 2x JSON-escaped (`"`, `\`), or 2-byte UTF-8 (`é`) headers are ignored.
    expect(resolveDemoActor(new Headers({ "x-demo-user": "u".repeat(129) }))).toBeUndefined();
    expect(resolveDemoTenant(new Headers({ "x-demo-tenant": "t".repeat(129) }))).toBeUndefined();
    expect(resolveDemoActor(new Headers({ "x-demo-user": '"'.repeat(65) }))).toBeUndefined();
    expect(resolveDemoTenant(new Headers({ "x-demo-tenant": "\\".repeat(65) }))).toBeUndefined();
    expect(resolveDemoActor(new Headers({ "x-demo-user": "\u00e9".repeat(65) }))).toBeUndefined();
    expect(
      resolveDemoActor(new Headers({ "x-demo-user": "alice", "x-demo-tenant": '"'.repeat(65) })),
    ).toEqual({ type: "user", id: "alice" });

    // Control characters and unpaired surrogates are ignored cleanly.
    expect(resolveDemoActor(new Headers({ "x-demo-user": "alice\u0007bell" }))).toBeUndefined();
    expect(resolveDemoTenant(new Headers({ "x-demo-tenant": "org\u001besc" }))).toBeUndefined();
    expect(resolveDemoTenant(new Headers({ "x-demo-tenant": "org\u007fdel" }))).toBeUndefined();
    const loneSurrogateHeaders = { get: () => "alice\uD800" } as unknown as Headers;
    expect(resolveDemoActor(loneSurrogateHeaders)).toBeUndefined();

    // Worst-case accepted headers (64 quotes = 128 JSON bytes each + 64-char requestId) fit safely in audit.as()'s 512-byte cap.
    const maxHeaders = new Headers({
      "x-demo-user": '"'.repeat(64),
      "x-demo-tenant": '"'.repeat(64),
      "x-request-id": "r".repeat(64),
    });
    const maxActor = resolveDemoActor(maxHeaders);
    expect(maxActor).toEqual({
      type: "user",
      id: '"'.repeat(64),
      tenant: '"'.repeat(64),
    });
    const maxContext = resolveAuditContext(maxHeaders, "examples/next-prisma:set-config");
    const scoped = await audit.as(maxActor as NonNullable<typeof maxActor>, () => audit.current(), {
      context: maxContext,
    });
    expect(scoped?.actor.id).toBe('"'.repeat(64));
  });

  it("re-exports AuditstreamError semantics cleanly on invalid limit", async () => {
    await expect(queryActivityFeed({ limit: 0 })).rejects.toBeInstanceOf(AuditstreamError);
  });
});
