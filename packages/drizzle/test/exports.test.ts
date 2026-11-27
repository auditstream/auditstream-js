import { describe, expect, it } from "vitest";

describe("@auditstream/drizzle exports", () => {
  it("resolves every declared subpath and re-exports the canonical @auditstream/node driver wrappers", async () => {
    const root = await import("@auditstream/drizzle");
    const pg = await import("@auditstream/drizzle/pg");
    const neonHttp = await import("@auditstream/drizzle/neon-http");
    const postgresJs = await import("@auditstream/drizzle/postgres-js");

    const nodePg = await import("@auditstream/node/pg");
    const nodeNeonHttp = await import("@auditstream/node/neon-http");
    const nodePostgresJs = await import("@auditstream/node/postgres-js");

    expect(root.PACKAGE_NAME).toBe("@auditstream/drizzle");
    expect(pg.SUBPATH).toBe("@auditstream/drizzle/pg");
    expect(neonHttp.SUBPATH).toBe("@auditstream/drizzle/neon-http");
    expect(postgresJs.SUBPATH).toBe("@auditstream/drizzle/postgres-js");

    // Re-exports share the exact function identity (and WeakSet state) with @auditstream/node/*.
    expect(pg.wrapPgPool).toBe(nodePg.wrapPgPool);
    expect(neonHttp.wrapNeonHttp).toBe(nodeNeonHttp.wrapNeonHttp);
    expect(postgresJs.wrapPostgresJs).toBe(nodePostgresJs.wrapPostgresJs);
  });
});
