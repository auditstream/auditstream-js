import { audit, encodeScope } from "@auditstream/node";
import type { SqlCommenterPlugin as PrismaSqlCommenterPlugin } from "@prisma/sqlcommenter";
import { describe, expect, it } from "vitest";
import { auditstream, PACKAGE_NAME } from "../src/index.js";

describe("@auditstream/prisma comments plugin", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@auditstream/prisma");
  });

  it("is structurally assignable to @prisma/sqlcommenter's SqlCommenterPlugin", () => {
    const plugin: PrismaSqlCommenterPlugin = auditstream();
    expect(typeof plugin).toBe("function");
  });

  it("returns an empty object with no auditstream key outside any audit.as() scope", () => {
    const plugin = auditstream();
    const tags = plugin();
    expect(tags).toEqual({});
    expect("auditstream" in tags).toBe(false);
    expect(Object.keys(tags)).toEqual([]);
  });

  it("returns { auditstream: encodeScope(scope) } inside an audit.as() scope", async () => {
    const plugin = auditstream();
    const actor = {
      type: "ai_agent" as const,
      id: "billing-agent",
      onBehalfOf: { type: "user" as const, id: "u_42" },
    };
    const context = { requestId: "req_1", source: "api" };

    const tags = await audit.as(actor, () => plugin(), { context });
    expect(tags).toEqual({
      auditstream: encodeScope({ actor, context }),
    });
  });

  it("isolates concurrent scopes and restores empty tags once a scope exits", async () => {
    const plugin = auditstream();

    const [a, b] = await Promise.all([
      audit.as({ type: "user", id: "alice" }, async () => {
        await Promise.resolve();
        return plugin();
      }),
      audit.as({ type: "user", id: "bob" }, async () => {
        await Promise.resolve();
        return plugin();
      }),
    ]);

    expect(a).toEqual({ auditstream: encodeScope({ actor: { type: "user", id: "alice" } }) });
    expect(b).toEqual({ auditstream: encodeScope({ actor: { type: "user", id: "bob" } }) });
    expect(plugin()).toEqual({});
  });
});
