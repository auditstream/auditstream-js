import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("@auditstream/node exports", () => {
  it("resolves every declared subpath from the built package and shares one AsyncLocalStorage", async () => {
    const root = await import("@auditstream/node");
    const expressEntry = await import("@auditstream/node/express");
    const honoEntry = await import("@auditstream/node/hono");
    const nextEntry = await import("@auditstream/node/next");
    const pgEntry = await import("@auditstream/node/pg");
    const postgresJsEntry = await import("@auditstream/node/postgres-js");
    const neonHttpEntry = await import("@auditstream/node/neon-http");

    expect(root.PACKAGE_NAME).toBe("@auditstream/node");
    expect(typeof root.audit.as).toBe("function");
    expect(typeof root.audit.current).toBe("function");
    expect(typeof expressEntry.auditstream).toBe("function");
    expect(typeof honoEntry.auditstream).toBe("function");
    expect(typeof nextEntry.withAudit).toBe("function");
    expect(typeof nextEntry.auditAction).toBe("function");
    expect(pgEntry.SUBPATH).toBe("@auditstream/node/pg");
    expect(typeof pgEntry.wrapPgPool).toBe("function");
    expect(postgresJsEntry.SUBPATH).toBe("@auditstream/node/postgres-js");
    expect(typeof postgresJsEntry.wrapPostgresJs).toBe("function");
    expect(neonHttpEntry.SUBPATH).toBe("@auditstream/node/neon-http");
    expect(typeof neonHttpEntry.wrapNeonHttp).toBe("function");

    // Verify built subpath helpers share the exact same AsyncLocalStorage instance as built root.
    const wrapped = nextEntry.auditAction(() => root.audit.current(), {
      actor: () => ({ type: "user", id: "usr_shared_als" }),
    });
    expect(await wrapped()).toEqual({ actor: { type: "user", id: "usr_shared_als" } });

    const seenQueries: string[] = [];
    const fakePool = pgEntry.wrapPgPool({
      on: () => undefined,
      query: (config: { text: string; values?: unknown[] }) => {
        seenQueries.push(config.text);
        return Promise.resolve({ rows: [] });
      },
    });
    const fakePostgresJs = postgresJsEntry.wrapPostgresJs({
      begin: () => Promise.resolve(),
      unsafe: (query: string, _params?: unknown[]) => {
        seenQueries.push(query);
        return Promise.resolve([]);
      },
    });
    const fakeNeon = neonHttpEntry.wrapNeonHttp(
      Object.assign(
        (text: string, _params?: unknown[]) => {
          seenQueries.push(text);
          return Promise.resolve([]);
        },
        {
          query: (text: string, _params?: unknown[]) => {
            seenQueries.push(text);
            return Promise.resolve([]);
          },
        },
      ),
    );
    await root.audit.as({ type: "user", id: "usr_driver_shared_als" }, async () => {
      await fakePool.query({ text: "UPDATE invoice SET status = $1", values: ["paid"] });
      await fakePostgresJs.unsafe("UPDATE invoice SET status = $1", ["paid"]);
      await fakeNeon.query("UPDATE invoice SET status = $1", ["paid"]);
    });
    expect(seenQueries).toHaveLength(3);
    for (const query of seenQueries) {
      expect(root.decodeScope(query)).toEqual({
        actor: { type: "user", id: "usr_driver_shared_als" },
        context: null,
        actorSource: "comment",
      });
    }
  });

  it("built entries never import express, hono, next, drizzle-orm, or database drivers at runtime", () => {
    const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const distDir = resolve(pkgRoot, "dist");
    const rootBundle = readFileSync(resolve(distDir, "index.mjs"), "utf8");

    const forbidden =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:express|hono|next|drizzle-orm|pg|postgres|@neondatabase\/serverless)(?:\/[^"']*)?["']/;
    expect(rootBundle).not.toMatch(forbidden);

    // Also verify no built chunk pulls in any framework, ORM, or database driver at runtime.
    for (const file of readdirSync(distDir)) {
      if (!file.endsWith(".mjs")) continue;
      const source = readFileSync(resolve(distDir, file), "utf8");
      expect(
        source,
        `dist/${file} must not import framework, ORM, or driver packages at runtime`,
      ).not.toMatch(forbidden);
    }
  });
});
