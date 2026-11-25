import { describe, expect, it, vi } from "vitest";
import { hasInvalidText } from "../src/context.js";
import { type AuditScope, audit, encodeScope, setConfigValue } from "../src/index.js";

const actor = { type: "user", id: "fixture" } as const;

describe("actor and context text", () => {
  const invalidFields: [AuditScope, string][] = [
    [{ actor: { ...actor, id: "a\0b" } }, "INVALID_ACTOR"],
    [{ actor: { ...actor, tenant: "\ud800" } }, "INVALID_ACTOR"],
    [{ actor: { ...actor, id: "\udfff\ud800" } }, "INVALID_ACTOR"],
    [{ actor: { ...actor, id: "ok\ud800" } }, "INVALID_ACTOR"],
    [{ actor: { ...actor, id: "\udfffok" } }, "INVALID_ACTOR"],
    [{ actor: { ...actor, onBehalfOf: { ...actor, id: "\udfff" } } }, "INVALID_ACTOR"],
    [{ actor, context: { requestId: "a\0b" } }, "INVALID_CONTEXT"],
    [{ actor, context: { source: "\ud800" } }, "INVALID_CONTEXT"],
    [{ actor, context: { userAgent: "\udfff" } }, "INVALID_CONTEXT"],
  ];

  it.each(invalidFields)(
    "rejects invalid scope text before entering audit.as %#",
    async (scope, code) => {
      const fn = vi.fn();
      await expect(audit.as(scope.actor, fn, scope)).rejects.toMatchObject({
        name: "AuditstreamError",
        code,
      });
      expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(invalidFields)("rejects invalid text in a directly encoded scope %#", (scope, code) => {
    expect(() => encodeScope(scope)).toThrowError(expect.objectContaining({ code }));
  });

  it("checks keys and values in serialized extension fields", () => {
    const extendedActor = { ...actor, extra: [{ label: "\ud800" }] };
    const extendedContext = { source: "test", labels: { "a\0b": 1 } };
    expect(() => setConfigValue({ actor: extendedActor })).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );
    expect(() => setConfigValue({ actor, context: extendedContext })).toThrowError(
      expect.objectContaining({ code: "INVALID_CONTEXT" }),
    );
  });

  it("revalidates scopes cached by an older package copy", () => {
    const legacyKey = Symbol.for("auditstream.node.scopeCache.v1");
    const globals = globalThis as Record<symbol, WeakMap<AuditScope, unknown> | undefined>;
    globals[legacyKey] ??= new WeakMap();
    const scope = { actor: { ...actor, id: "\ud800" } };
    const json = JSON.stringify(scope.actor);
    globals[legacyKey].set(scope, { json, bytes: new TextEncoder().encode(json) });

    expect(() => setConfigValue(scope)).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );
  });

  it("preserves supplementary characters and literal escape sequences", async () => {
    const scope = { actor: { ...actor, id: "📦\\u0000" }, context: { source: "🚀\\udfff" } };
    const json = JSON.stringify({ ...scope.actor, context: scope.context });
    expect(setConfigValue(scope)).toBe(json);
    await audit.as(scope.actor, () => expect(audit.current()).toEqual(scope), scope);
  });

  it("checks deeply nested structures iteratively without overflowing the call stack", () => {
    let deepInvalid: Record<string, unknown> = { leaf: "a\0b" };
    let deepValid: Record<string, unknown> = { leaf: "a\\u0000" };
    for (let i = 0; i < 15_000; i++) {
      deepInvalid = { nested: deepInvalid };
      deepValid = { nested: deepValid };
    }
    expect(hasInvalidText(deepInvalid)).toBe(true);
    expect(hasInvalidText(deepValid)).toBe(false);
  });
});
