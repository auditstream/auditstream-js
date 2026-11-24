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

  it("caches canonical payload and encoded tag per audit.as() scope via process-wide WeakMap", async () => {
    const cacheSymbol = Symbol.for("auditstream.node.scopeCache.v1");
    const scopeCache = (globalThis as Record<PropertyKey, unknown>)[cacheSymbol];
    expect(scopeCache).toBeInstanceOf(WeakMap);

    await audit.as(
      {
        type: "ai_agent",
        id: "billing-agent",
        onBehalfOf: { type: "user", id: "usr_42", tenant: "org_acme" },
        tenant: "org_acme",
      },
      () => {
        const active = audit.current();
        expect(active).toBeDefined();
        if (!active) {
          throw new Error("expected active scope");
        }

        const cache = scopeCache as WeakMap<
          AuditScope,
          { json: string; encoded?: string; commentSuffix?: string }
        >;
        const entry = cache.get(active);
        expect(entry).toBeDefined();
        expect(entry?.json).toBe(setConfigValue(active));

        const firstEncoded = encodeScope(active);
        expect(entry?.encoded).toBe(firstEncoded);
        expect(encodeScope(active)).toBe(firstEncoded);

        const tagged = tagSql("UPDATE invoice SET status = $1", active);
        expect(entry?.commentSuffix).toBe(` /*auditstream='${firstEncoded}'*/`);
        expect(tagged).toBe(`UPDATE invoice SET status = $1 /*auditstream='${firstEncoded}'*/`);
      },
      { context: { requestId: "req_cache_1", source: "api" } },
    );
  });

  it("property test (1,000 runs): cached audit.as() scopes match uncached encodeScope, setConfigValue, and tagSql byte-for-byte", async () => {
    await fc.assert(
      fc.asyncProperty(arbScope, async (scope) => {
        const expectedEncoded = encodeScope(scope);
        const expectedJson = setConfigValue(scope);
        const expectedSql = tagSql("UPDATE invoice SET status = $1", scope);

        await audit.as(
          scope.actor,
          () => {
            const active = audit.current();
            expect(active).toBeDefined();
            if (!active) {
              throw new Error("expected active scope");
            }
            expect(setConfigValue(active)).toBe(expectedJson);
            expect(encodeScope(active)).toBe(expectedEncoded);
            expect(encodeScope(active)).toBe(expectedEncoded);
            expect(tagSql("UPDATE invoice SET status = $1")).toBe(expectedSql);
            expect(tagSql("UPDATE invoice SET status = $1", active)).toBe(expectedSql);
          },
          scope.context !== undefined ? { context: scope.context } : undefined,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it("never caches mutable caller-constructed scopes passed directly to encodeScope/setConfigValue/tagSql", () => {
    const mutableActor: { type: ActorType; id: string } = { type: "user", id: "usr_before" };
    const mutableContext: { requestId: string } = { requestId: "req_1" };
    const mutableScope = { actor: mutableActor, context: mutableContext };

    const encodedBefore = encodeScope(mutableScope);
    const jsonBefore = setConfigValue(mutableScope);
    const sqlBefore = tagSql("SELECT 1", mutableScope);

    mutableActor.id = "usr_after";
    mutableContext.requestId = "req_2";

    const encodedAfter = encodeScope(mutableScope);
    const jsonAfter = setConfigValue(mutableScope);
    const sqlAfter = tagSql("SELECT 1", mutableScope);

    expect(encodedAfter).not.toBe(encodedBefore);
    expect(jsonAfter).not.toBe(jsonBefore);
    expect(sqlAfter).not.toBe(sqlBefore);
    expect(decodeScope(sqlAfter)).toEqual({
      actor: { type: "user", id: "usr_after" },
      context: { requestId: "req_2" },
      actorSource: "comment",
    });
  });

  it("isTagged and decodeScope handle comment edge cases, long SQL (>4096 chars), and Unicode trailing whitespace", () => {
    const validTag = "eyJ0eXBlIjoidXNlciIsImlkIjoidXNyXzQyIn0";

    // Overlapping slash/star and empty comments MUST NOT match.
    for (const edge of [
      "",
      "/*/",
      "a/*/",
      "/*a/*/",
      "/**/",
      "SELECT 1 /**/",
      "SELECT 1 /*foo/auditstream='abc'*/",
      "SELECT 1 /*foo_auditstream='abc'*/",
      "SELECT 1 /*auditstream='unterminated*/",
      "SELECT 1 /*traceparent='00-abc'*/",
    ]) {
      expect(isTagged(edge), `isTagged(${edge})`).toBe(false);
      expect(decodeScope(edge), `decodeScope(${edge})`).toEqual({
        actor: null,
        context: null,
        actorSource: null,
      });
    }

    // Empty or malformed base64url payloads are tagged (won't double-tag) and decode as invalid.
    for (const malformed of [
      "SELECT 1 /*auditstream=''*/",
      "SELECT 1 /*auditstream='a!'*/",
      "SELECT 1 /*auditstream='ab!'*/",
      "SELECT 1 /*auditstream='abcdé!'*/",
      "SELECT 1 /*auditstream='abé'*/",
    ]) {
      expect(isTagged(malformed), `isTagged(${malformed})`).toBe(true);
      expect(decodeScope(malformed), `decodeScope(${malformed})`).toEqual({
        actor: null,
        context: null,
        actorSource: "invalid",
      });
    }

    // Trailing Unicode whitespace (\u00A0) falls back cleanly to regex parity.
    const unicodeTrailing = `UPDATE t SET v = 1 /*auditstream='${validTag}'*/\u00A0; `;
    expect(isTagged(unicodeTrailing)).toBe(true);
    expect(decodeScope(unicodeTrailing)).toEqual({
      actor: { type: "user", id: "usr_42" },
      context: null,
      actorSource: "comment",
    });

    // Long SQL > 4096 chars: untagged vs tagged at end vs comment buried before the 4096-char tail.
    const padding = " ".repeat(5000);
    const longUntagged = `SELECT 1${padding}FROM invoice WHERE id = $1`;
    expect(isTagged(longUntagged)).toBe(false);
    expect(decodeScope(longUntagged).actorSource).toBeNull();

    const longTagged = `${longUntagged} /*auditstream='${validTag}'*/;`;
    expect(isTagged(longTagged)).toBe(true);
    expect(decodeScope(longTagged).actor).toEqual({ type: "user", id: "usr_42" });

    // Comment whose opening `/*` falls before the last 4096 chars is outside the tail window.
    const oversizedComment = `SELECT 1 /*${"a".repeat(4100)},auditstream='${validTag}'*/`;
    expect(isTagged(oversizedComment)).toBe(false);
    expect(decodeScope(oversizedComment).actorSource).toBeNull();
  });

  it("decodeScope enforces full Spec 0.1.0 actor and context validation while preserving unknown keys", () => {
    const toCommentSql = (payload: unknown): string => {
      const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return `UPDATE invoice SET status = 'ok' /*auditstream='${b64}'*/`;
    };

    const invalidPayloads: readonly unknown[] = [
      { type: "bot", id: "b1" },
      { type: "user", id: "u1", tenant: "" },
      { type: "user", id: "u1", tenant: 123 },
      { type: "user", id: "u1", tenant: null },
      { type: "ai_agent", id: "a1", onBehalfOf: "bad" },
      { type: "ai_agent", id: "a1", onBehalfOf: { type: "bot", id: "b1" } },
      { type: "ai_agent", id: "a1", onBehalfOf: { type: "user", id: "" } },
      { type: "ai_agent", id: "a1", onBehalfOf: { type: "user", id: "u1", tenant: "" } },
      {
        type: "ai_agent",
        id: "a1",
        onBehalfOf: { type: "user", id: "u1", onBehalfOf: null },
      },
      {
        type: "ai_agent",
        id: "a1",
        onBehalfOf: {
          type: "ai_agent",
          id: "a2",
          onBehalfOf: { type: "user", id: "u1" },
        },
      },
      { type: "user", id: "u1", context: "bad" },
      { type: "user", id: "u1", context: null },
      { type: "user", id: "u1", context: [] },
      { type: "user", id: "u1", context: { requestId: "" } },
      { type: "user", id: "u1", context: { source: 42 } },
      { type: "user", id: "u1", context: { ip: "" } },
      { type: "user", id: "u1", context: { userAgent: null } },
    ];

    for (const payload of invalidPayloads) {
      expect(decodeScope(toCommentSql(payload)), JSON.stringify(payload)).toEqual({
        actor: null,
        context: null,
        actorSource: "invalid",
      });
    }

    // Empty context object and additive unknown keys remain valid.
    expect(decodeScope(toCommentSql({ type: "user", id: "u1", context: {} }))).toEqual({
      actor: { type: "user", id: "u1" },
      context: {},
      actorSource: "comment",
    });

    expect(
      decodeScope(
        toCommentSql({
          type: "ai_agent",
          id: "a1",
          futureKey: "v1",
          onBehalfOf: { type: "user", id: "u1", extraNested: true },
          context: { requestId: "r1", futureCtx: 42 },
        }),
      ),
    ).toEqual({
      actor: {
        type: "ai_agent",
        id: "a1",
        futureKey: "v1",
        onBehalfOf: { type: "user", id: "u1", extraNested: true },
      },
      context: { requestId: "r1", futureCtx: 42 },
      actorSource: "comment",
    });
  });
});
