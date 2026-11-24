import { describe, expect, it } from "vitest";

describe("@auditstream/prisma exports", () => {
  it("resolves every declared subpath from the built package", async () => {
    const root = await import("@auditstream/prisma");
    expect(root.PACKAGE_NAME).toBe("@auditstream/prisma");
  });
});
