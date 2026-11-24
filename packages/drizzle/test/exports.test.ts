import { describe, expect, it } from "vitest";

describe("@auditstream/drizzle exports", () => {
  it("resolves every declared subpath from the built package", async () => {
    const root = await import("@auditstream/drizzle");
    const pg = await import("@auditstream/drizzle/pg");
    const neonHttp = await import("@auditstream/drizzle/neon-http");
    const postgresJs = await import("@auditstream/drizzle/postgres-js");

    expect(root.PACKAGE_NAME).toBe("@auditstream/drizzle");
    expect(pg.SUBPATH).toBe("@auditstream/drizzle/pg");
    expect(neonHttp.SUBPATH).toBe("@auditstream/drizzle/neon-http");
    expect(postgresJs.SUBPATH).toBe("@auditstream/drizzle/postgres-js");
  });
});
