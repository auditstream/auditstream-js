import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, stopTestCluster, type TestDatabase } from "@auditstream/test-utils";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = resolve(__dirname, "..");
const PRISMA_BIN = resolve(EXAMPLE_DIR, "node_modules/.bin/prisma");
const NEXT_BIN = resolve(EXAMPLE_DIR, "node_modules/.bin/next");

interface InvoiceResponse {
  readonly id: number;
  readonly status: string;
  readonly total: string;
}

interface AuditChangeRow {
  readonly table_name: string;
  readonly op: string;
  readonly pk: number;
  readonly status: string | null;
  readonly actor_id: string | null;
  readonly actor_source: string | null;
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address !== "object") {
        srv.close(() => rejectPort(new Error("Failed to allocate port")));
        return;
      }
      const { port } = address;
      srv.close((err) => {
        if (err) {
          rejectPort(err);
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited early with code ${child.exitCode}:\n${logs.join("")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // Retry until the server begins listening.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for Next.js server at ${baseUrl}:\n${logs.join("")}`);
}

async function getLatestChangeId(admin: pg.Client): Promise<string> {
  const res = await admin.query<{ m: string }>(
    "SELECT coalesce(max(id), 0)::text AS m FROM auditstream.changes",
  );
  return res.rows[0]?.m ?? "0";
}

async function fetchChangesSince(admin: pg.Client, sinceId: string): Promise<AuditChangeRow[]> {
  const res = await admin.query<AuditChangeRow>(
    `SELECT table_name,
            op,
            (record_id->>'id')::int AS pk,
            coalesce(after->>'status', before->>'status') AS status,
            actor->>'id' AS actor_id,
            actor_source
       FROM auditstream.changes
      WHERE id > $1
        AND table_name = 'invoice'
      ORDER BY id ASC`,
    [sinceId],
  );
  return res.rows;
}

describe("examples/next-prisma smoke test", () => {
  let db: TestDatabase;
  let admin: pg.Client;
  let server: ChildProcess | undefined;
  let baseUrl = "";
  const serverLogs: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();

    // Strip the prototype schema so the real Prisma + Auditstream migrations deploy cleanly.
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS auditstream CASCADE;");
    await admin.query("DROP TABLE IF EXISTS public.line_item, public.invoice CASCADE;");
    await admin.query("DROP TABLE IF EXISTS public._prisma_migrations CASCADE;");

    const cliEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: db.adminUrl,
      NEXT_TELEMETRY_DISABLED: "1",
    };

    execFileSync(PRISMA_BIN, ["generate", "--config", "prisma.config.ts"], {
      cwd: EXAMPLE_DIR,
      env: cliEnv,
      stdio: "pipe",
    });

    execFileSync(PRISMA_BIN, ["migrate", "deploy", "--config", "prisma.config.ts"], {
      cwd: EXAMPLE_DIR,
      env: cliEnv,
      stdio: "pipe",
    });

    execFileSync(NEXT_BIN, ["build"], {
      cwd: EXAMPLE_DIR,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "pipe",
    });

    const port = await allocateFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(NEXT_BIN, ["start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: EXAMPLE_DIR,
      env: {
        ...process.env,
        DATABASE_URL: db.appUrl,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk: Buffer) => serverLogs.push(chunk.toString("utf8")));
    server.stderr?.on("data", (chunk: Buffer) => serverLogs.push(chunk.toString("utf8")));

    await waitForHealth(baseUrl, server, serverLogs);
  });

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          server?.kill("SIGKILL");
          resolveExit();
        }, 5_000);
        server?.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    await admin?.end();
    await db?.drop();
    await stopTestCluster();
  });

  it("captures Route Handlers (comment), auditTransaction (set_config), and Server Action (auditAction)", async () => {
    const startId = await getLatestChangeId(admin);

    // 1. POST /api/invoices via withAudit -> comment
    const createRes = await fetch(`${baseUrl}/api/invoices`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "alice",
        "x-request-id": "req-next-1",
      },
      body: JSON.stringify({ status: "draft", total: "50.00" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as InvoiceResponse;

    // 2. PATCH /api/invoices/[id] via withAudit -> comment
    const patchRes = await fetch(`${baseUrl}/api/invoices/${created.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "bob",
      },
      body: JSON.stringify({ status: "review", total: "125.00" }),
    });
    expect(patchRes.status).toBe(200);

    // 3. POST /api/invoices/[id]/approve via auditTransaction -> set_config
    const approveRes = await fetch(`${baseUrl}/api/invoices/${created.id}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "carol",
      },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(approveRes.status).toBe(200);

    // 4. Server Action form on `/` wrapped with auditAction -> comment
    const pageRes = await fetch(`${baseUrl}/`);
    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    const actionMatch = html.match(/name="(\$ACTION_ID_[^"]+)"/);
    expect(actionMatch?.[1]).toBeDefined();
    const actionField = actionMatch?.[1] ?? "";

    const form = new FormData();
    form.set(actionField, "");
    form.set("id", String(created.id));
    form.set("status", "sent-via-action");

    const actionRes = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        origin: baseUrl,
        "x-demo-user": "dave-action",
      },
      body: form,
    });
    expect(actionRes.ok).toBe(true);

    // 5. Unscoped Route Handler call (no x-demo-user) -> actor NULL
    const unscopedRes = await fetch(`${baseUrl}/api/invoices`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "unscoped", total: "10.00" }),
    });
    expect(unscopedRes.status).toBe(201);
    const unscoped = (await unscopedRes.json()) as InvoiceResponse;

    const rows = await fetchChangesSince(admin, startId);
    expect(rows).toEqual([
      {
        table_name: "invoice",
        op: "INSERT",
        pk: created.id,
        status: "draft",
        actor_id: "alice",
        actor_source: "comment",
      },
      {
        table_name: "invoice",
        op: "UPDATE",
        pk: created.id,
        status: "review",
        actor_id: "bob",
        actor_source: "comment",
      },
      {
        table_name: "invoice",
        op: "UPDATE",
        pk: created.id,
        status: "approved",
        actor_id: "carol",
        actor_source: "set_config",
      },
      {
        table_name: "invoice",
        op: "UPDATE",
        pk: created.id,
        status: "sent-via-action",
        actor_id: "dave-action",
        actor_source: "comment",
      },
      {
        table_name: "invoice",
        op: "INSERT",
        pk: unscoped.id,
        status: "unscoped",
        actor_id: null,
        actor_source: null,
      },
    ]);
  });

  it("handles 40 concurrent requests with distinct demo users through a pool of 5 with zero wrong actors and expected actor_source", async () => {
    const count = 40;
    const indices = Array.from({ length: count }, (_, i) => i);

    // Seed 40 invoices so concurrent updates contend on the 5-connection pool across both transports.
    const seededIds: number[] = [];
    for (const i of indices) {
      const res = await admin.query<{ id: number }>(
        "INSERT INTO public.invoice (status, total) VALUES ($1, $2) RETURNING id",
        [`seed-${i}`, `${100 + i}.00`],
      );
      const id = res.rows[0]?.id;
      if (id === undefined) {
        throw new Error("Failed to seed invoice");
      }
      seededIds.push(id);
    }

    const startId = await getLatestChangeId(admin);

    await Promise.all(
      indices.map(async (i) => {
        const id = seededIds[i];
        const userId = `next-user-${i}`;
        const useSetConfig = i % 2 === 1;
        const url = useSetConfig
          ? `${baseUrl}/api/invoices/${id}/approve`
          : `${baseUrl}/api/invoices/${id}`;
        const method = useSetConfig ? "POST" : "PATCH";

        const res = await fetch(url, {
          method,
          headers: {
            "content-type": "application/json",
            "x-demo-user": userId,
          },
          body: JSON.stringify({ status: userId }),
        });
        expect(res.status).toBe(200);
      }),
    );

    const rows = await fetchChangesSince(admin, startId);
    expect(rows).toHaveLength(count);

    const byPk = new Map<number, AuditChangeRow>(rows.map((r) => [r.pk, r]));
    let wrongActors = 0;

    for (const i of indices) {
      const id = seededIds[i] ?? -1;
      const expectedUser = `next-user-${i}`;
      const expectedSource = i % 2 === 1 ? "set_config" : "comment";
      const row = byPk.get(id);

      expect(row).toBeDefined();
      expect(row?.op).toBe("UPDATE");
      expect(row?.status).toBe(expectedUser);
      expect(row?.actor_source).toBe(expectedSource);
      if (row?.actor_id !== expectedUser) {
        wrongActors += 1;
      }
    }

    expect(wrongActors).toBe(0);
  });

  it("serves allowlisted Activity Feed DTOs across db and app events with keyset pagination and server-enforced tenant scoping", async () => {
    // Seed 3 events under org_acme (db INSERT, db UPDATE, app invoice.exported) and 1 under org_beta.
    const createAcme = await fetch(`${baseUrl}/api/invoices`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "alice",
        "x-demo-tenant": "org_acme",
      },
      body: JSON.stringify({ status: "draft", total: "75.00" }),
    });
    expect(createAcme.status).toBe(201);
    const acmeInvoice = (await createAcme.json()) as InvoiceResponse;

    const patchAcme = await fetch(`${baseUrl}/api/invoices/${acmeInvoice.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "bob",
        "x-demo-tenant": "org_acme",
      },
      body: JSON.stringify({ status: "approved", total: "90.00" }),
    });
    expect(patchAcme.status).toBe(200);

    const exportAcme = await fetch(`${baseUrl}/api/invoices/${acmeInvoice.id}/export`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "carol",
        "x-demo-tenant": "org_acme",
      },
      body: JSON.stringify({ format: "csv" }),
    });
    expect(exportAcme.status).toBe(201);

    const createBeta = await fetch(`${baseUrl}/api/invoices`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-user": "usr_42",
        "x-demo-tenant": "org_beta",
      },
      body: JSON.stringify({ status: "beta-only", total: "15.00" }),
    });
    expect(createBeta.status).toBe(201);

    interface ActivityItemDto {
      readonly eventId: string;
      readonly occurredAt: string;
      readonly source: string;
      readonly action: string;
      readonly entity: string;
      readonly recordId: string | null;
      readonly changedFields: readonly string[];
      readonly summary: string;
      readonly actor: {
        readonly id: string;
        readonly type: string;
        readonly displayName: string;
      } | null;
    }

    interface ActivityPageDto {
      readonly items: readonly ActivityItemDto[];
      readonly nextCursor: string | null;
      readonly hasMore: boolean;
    }

    // Page 1: pass adversarial ?tenant=org_beta query param; server must enforce x-demo-tenant=org_acme.
    const page1Res = await fetch(`${baseUrl}/api/activity?limit=2&tenant=org_beta`, {
      headers: { "x-demo-tenant": "org_acme" },
    });
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as ActivityPageDto;
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(typeof page1.nextCursor).toBe("string");
    expect(page1.nextCursor?.length).toBeGreaterThan(0);

    // Page 2 via opaque keyset nextCursor.
    const page2Res = await fetch(
      `${baseUrl}/api/activity?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? "")}`,
      { headers: { "x-demo-tenant": "org_acme" } },
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as ActivityPageDto;
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const allItems = [...page1.items, ...page2.items];
    expect(new Set(allItems.map((item) => item.eventId)).size).toBe(3);

    // Every item strictly matches the allowlisted client DTO (no internal columns or raw snapshots).
    const allowedKeys = [
      "action",
      "actor",
      "changedFields",
      "entity",
      "eventId",
      "occurredAt",
      "recordId",
      "source",
      "summary",
    ];
    for (const item of allItems) {
      expect(Object.keys(item).sort()).toEqual(allowedKeys);
      for (const forbidden of [
        "id",
        "xact_id",
        "table_oid",
        "db_user",
        "actor_source",
        "before",
        "after",
        "context",
        "schema_version",
      ]) {
        expect(item).not.toHaveProperty(forbidden);
      }
    }

    // Newest-first order: app invoice.exported -> db UPDATE -> db INSERT, with resolved actor names.
    expect(allItems.map((item) => ({ source: item.source, action: item.action }))).toEqual([
      { source: "app", action: "invoice.exported" },
      { source: "db", action: "UPDATE" },
      { source: "db", action: "INSERT" },
    ]);
    expect(allItems.map((item) => item.actor?.displayName)).toEqual([
      "Carol Diaz",
      "Bob Chen",
      "Alice Rivera",
    ]);
    expect(allItems[0]?.summary).toContain("csv");
    expect(allItems[1]?.changedFields).toEqual(["status", "total"]);

    // Filter by source=app and opPrefix=invoice.
    const appOnlyRes = await fetch(`${baseUrl}/api/activity?source=app&opPrefix=invoice.`, {
      headers: { "x-demo-tenant": "org_acme" },
    });
    expect(appOnlyRes.status).toBe(200);
    const appOnly = (await appOnlyRes.json()) as ActivityPageDto;
    expect(appOnly.items).toHaveLength(1);
    expect(appOnly.items[0]?.action).toBe("invoice.exported");
    expect(appOnly.hasMore).toBe(false);

    // Date window filter (future since -> empty page).
    const emptyRes = await fetch(`${baseUrl}/api/activity?since=2099-01-01`, {
      headers: { "x-demo-tenant": "org_acme" },
    });
    expect(emptyRes.status).toBe(200);
    const emptyPage = (await emptyRes.json()) as ActivityPageDto;
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.hasMore).toBe(false);
    expect(emptyPage.nextCursor).toBeNull();

    // Validation errors return HTTP 400.
    const badSourceRes = await fetch(`${baseUrl}/api/activity?source=invalid`);
    expect(badSourceRes.status).toBe(400);
    const badCursorRes = await fetch(`${baseUrl}/api/activity?cursor=not-a-valid-cursor`);
    expect(badCursorRes.status).toBe(400);

    // SSR Activity Feed page renders cleanly with resolved actor names.
    const feedPageRes = await fetch(`${baseUrl}/activity`, {
      headers: { "x-demo-tenant": "org_acme" },
    });
    expect(feedPageRes.status).toBe(200);
    const feedHtml = await feedPageRes.text();
    expect(feedHtml).toContain("Activity Feed");
    expect(feedHtml).toContain("Carol Diaz");
    expect(feedHtml).toContain("invoice.exported");
  });
});
