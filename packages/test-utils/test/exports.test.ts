import { describe, expect, it } from "vitest";

describe("@auditstream/test-utils exports", () => {
  it("resolves the built test harness module", async () => {
    const mod = await import("@auditstream/test-utils");
    expect(typeof mod.createTestDatabase).toBe("function");
    expect(typeof mod.startPgBouncer).toBe("function");
    expect(typeof mod.stopTestCluster).toBe("function");
  });
});
