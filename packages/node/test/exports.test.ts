import { describe, expect, it } from "vitest";

describe("@auditstream/node exports", () => {
  it("resolves every declared subpath from the built package", async () => {
    const root = await import("@auditstream/node");
    const express = await import("@auditstream/node/express");
    const hono = await import("@auditstream/node/hono");
    const next = await import("@auditstream/node/next");

    expect(root.PACKAGE_NAME).toBe("@auditstream/node");
    expect(express.SUBPATH).toBe("@auditstream/node/express");
    expect(hono.SUBPATH).toBe("@auditstream/node/hono");
    expect(next.SUBPATH).toBe("@auditstream/node/next");
  });
});
