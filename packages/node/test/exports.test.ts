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

    expect(root.PACKAGE_NAME).toBe("@auditstream/node");
    expect(typeof root.audit.as).toBe("function");
    expect(typeof root.audit.current).toBe("function");
    expect(typeof expressEntry.auditstream).toBe("function");
    expect(typeof honoEntry.auditstream).toBe("function");
    expect(typeof nextEntry.withAudit).toBe("function");
    expect(typeof nextEntry.auditAction).toBe("function");

    // Verify built subpath helper shares the exact same AsyncLocalStorage instance as built root.
    const wrapped = nextEntry.auditAction(() => root.audit.current(), {
      actor: () => ({ type: "user", id: "usr_shared_als" }),
    });
    expect(await wrapped()).toEqual({ actor: { type: "user", id: "usr_shared_als" } });
  });

  it("built root entry never imports express, hono, or next", () => {
    const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
    const distDir = resolve(pkgRoot, "dist");
    const rootBundle = readFileSync(resolve(distDir, "index.mjs"), "utf8");

    const forbidden =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:express|hono|next)(?:\/[^"']*)?["']/;
    expect(rootBundle).not.toMatch(forbidden);

    // Also verify no shared chunk imported by dist/index.mjs pulls in any framework peer.
    for (const file of readdirSync(distDir)) {
      if (!file.endsWith(".mjs")) continue;
      const source = readFileSync(resolve(distDir, file), "utf8");
      expect(source, `dist/${file} must not import express, hono, or next at runtime`).not.toMatch(
        forbidden,
      );
    }
  });
});
