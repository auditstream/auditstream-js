import { describe, expect, it } from "vitest";

describe("@auditstream/test-utils exports", () => {
  it("resolves the built test harness module", async () => {
    const mod = await import("@auditstream/test-utils");
    expect(typeof mod.createTestDatabase).toBe("function");
    expect(typeof mod.startPgBouncer).toBe("function");
    expect(typeof mod.stopTestCluster).toBe("function");
  });

  it("sets app_user password only on initial role creation to avoid rotating SCRAM salts", async () => {
    const { buildRoleSetupSql } = await import("@auditstream/test-utils");
    const sql = buildRoleSetupSql("s3cr'et");
    expect(sql).toContain("CREATE ROLE app_user LOGIN PASSWORD");
    expect(sql).not.toContain("ALTER ROLE app_user");
  });
});
