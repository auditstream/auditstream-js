import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  type ActorType,
  type AuditContext,
  type AuditScope,
  AuditstreamError,
  audit,
  decodeScope,
  encodeScope,
  isTagged,
  MAX_PAYLOAD_BYTES,
  type NestedActor,
  setConfigValue,
  tagSql,
} from "../src/index.js";

const KIT_TAG_REGEX = /\/\*auditstream='[A-Za-z0-9_-]+'\*\/$/;

const arbActorType: fc.Arbitrary<ActorType> = fc.constantFrom(
  "user",
  "api_key",
  "ai_agent",
  "service",
  "system",
);

const arbNonEmptyString: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 24 });

const arbNestedActor: fc.Arbitrary<NestedActor> = fc
  .record(
    {
      type: arbActorType,
      id: arbNonEmptyString,
      tenant: arbNonEmptyString,
    },
    { requiredKeys: ["type", "id"] },
  )
  .map((rec) => rec as NestedActor);

const arbActor: fc.Arbitrary<Actor> = fc
  .record(
    {
      type: arbActorType,
      id: arbNonEmptyString,
      onBehalfOf: arbNestedActor,
      tenant: arbNonEmptyString,
    },
    { requiredKeys: ["type", "id"] },
  )
  .map((rec) => rec as Actor);

const arbContext: fc.Arbitrary<AuditContext> = fc.record(
  {
    requestId: arbNonEmptyString,
    source: arbNonEmptyString,
    ip: arbNonEmptyString,
    userAgent: arbNonEmptyString,
  },
  { requiredKeys: [] },
);

const arbScope: fc.Arbitrary<AuditScope> = fc
  .record(
    {
      actor: arbActor,
      context: arbContext,
    },
    { requiredKeys: ["actor"] },
  )
  .filter((scope) => {
    const payload = scope.context ? { ...scope.actor, context: scope.context } : scope.actor;
    return new TextEncoder().encode(JSON.stringify(payload)).byteLength <= MAX_PAYLOAD_BYTES;
  });

describe("@auditstream/node transport codec", () => {
  it("property test (1,000 runs): round-trips valid actors and never emits */, =, +, or /", () => {
    fc.assert(
      fc.property(arbScope, (scope) => {
        const encoded = encodeScope(scope);
        expect(encoded).not.toContain("*/");
        expect(encoded).not.toContain("=");
        expect(encoded).not.toContain("+");
        expect(encoded).not.toContain("/");

        const sql = tagSql("UPDATE invoice SET status = $1", scope);
        expect(KIT_TAG_REGEX.test(sql)).toBe(true);
        expect(isTagged(sql)).toBe(true);

        const decoded = decodeScope(sql);
        expect(decoded.actorSource).toBe("comment");
        expect(decoded.actor).toEqual(scope.actor);
        expect(decoded.context).toEqual(scope.context ?? null);
      }),
      { numRuns: 1000 },
    );
  });

  it("tagSql appends one tag after existing comments and returns unchanged with no scope or existing tag", async () => {
    const base = "SELECT /* hint */ 1";
    expect(tagSql(base)).toBe(base);
    expect(isTagged(base)).toBe(false);

    const tagged = await audit.as({ type: "user", id: "usr_42" }, () => {
      const once = tagSql(base);
      expect(KIT_TAG_REGEX.test(once)).toBe(true);
      expect(once.startsWith(`${base} /*auditstream='`)).toBe(true);
      expect(isTagged(once)).toBe(true);

      // Calling tagSql a second time MUST NOT double-tag.
      const twice = tagSql(once);
      expect(twice).toBe(once);
      return once;
    });

    // Shared sqlcommenter tag is also recognized as already tagged.
    const shared = `${base} /*traceparent='00-abc',auditstream='eyJ0eXBlIjoidXNlciIsImlkIjoidXNyXzQyIn0'*/;`;
    expect(isTagged(shared)).toBe(true);
    expect(tagSql(shared, { actor: { type: "user", id: "usr_99" } })).toBe(shared);
    expect(decodeScope(tagged).actor).toEqual({ type: "user", id: "usr_42" });
  });

  it("throws AuditstreamError before building SQL text when payload exceeds 512 bytes", () => {
    const oversized: AuditScope = {
      actor: { type: "user", id: "x".repeat(500) },
    };

    expect(() => encodeScope(oversized)).toThrowError(AuditstreamError);
    expect(() => tagSql("UPDATE t SET x = 1", oversized)).toThrowError(AuditstreamError);
    expect(() => setConfigValue(oversized)).toThrowError(AuditstreamError);

    try {
      tagSql("UPDATE t SET x = 1", oversized);
    } catch (err) {
      expect(err).toBeInstanceOf(AuditstreamError);
      expect((err as AuditstreamError).code).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("setConfigValue emits canonical key order regardless of caller property order", () => {
    // Deliberately supply keys in reverse order.
    const reversedActor = {
      tenant: "org_acme",
      onBehalfOf: { tenant: "org_acme", id: "usr_42", type: "user" as const },
      id: "billing-agent",
      type: "ai_agent" as const,
    };
    const reversedContext = {
      source: "api",
      requestId: "req_1",
    };

    const json = setConfigValue({ actor: reversedActor, context: reversedContext });
    expect(json).toBe(
      '{"type":"ai_agent","id":"billing-agent","onBehalfOf":{"type":"user","id":"usr_42","tenant":"org_acme"},"tenant":"org_acme","context":{"requestId":"req_1","source":"api"}}',
    );
  });

  it("works identically when globalThis.Buffer is absent (Cloudflare Workers portability)", () => {
    const originalBuffer = globalThis.Buffer;
    Reflect.deleteProperty(globalThis, "Buffer");
    try {
      expect("Buffer" in globalThis).toBe(false);
      const scope: AuditScope = {
        actor: {
          type: "ai_agent",
          id: "usuário-日本語-🚀",
          onBehalfOf: { type: "user", id: "usr_42" },
          tenant: "org_acme",
        },
        context: { requestId: "req_no_buf", source: "worker" },
      };

      const encoded = encodeScope(scope);
      const sql = tagSql("UPDATE invoice SET status = 'paid'", scope);
      const decoded = decodeScope(sql);
      expect(decoded.actorSource).toBe("comment");
      expect(decoded.actor).toEqual(scope.actor);
      expect(decoded.context).toEqual(scope.context);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });
});
