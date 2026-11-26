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
  parseExportRecord,
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
    const cacheSymbol = Symbol.for("auditstream.node.scopeCache.v2");
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

    // Empty or malformed base64url payloads MUST NOT suppress tagging (isTagged === false),
    // while decodeScope still reports them as invalid per spec/transport.md.
    const fallbackScope: AuditScope = { actor: { type: "user", id: "usr_fallback" } };
    for (const malformed of [
      "SELECT 1 /*auditstream=''*/",
      "SELECT 1 /*auditstream='a!'*/",
      "SELECT 1 /*auditstream='ab!'*/",
      "SELECT 1 /*auditstream='abcdé!'*/",
      "SELECT 1 /*auditstream='abé'*/",
    ]) {
      expect(isTagged(malformed), `isTagged(${malformed})`).toBe(false);
      expect(decodeScope(malformed), `decodeScope(${malformed})`).toEqual({
        actor: null,
        context: null,
        actorSource: "invalid",
      });
      const retagged = tagSql(malformed, fallbackScope);
      expect(retagged).not.toBe(malformed);
      expect(isTagged(retagged)).toBe(true);
      expect(decodeScope(retagged)).toEqual({
        actor: { type: "user", id: "usr_fallback" },
        context: null,
        actorSource: "comment",
      });
    }

    // Trailing ASCII whitespace (\t\n\r\f\v ) and semicolons match PostgreSQL resolve_actor().
    const asciiTrailing = `UPDATE t SET v = 1 /*auditstream='${validTag}'*/ \t\r\n\f\v; `;
    expect(isTagged(asciiTrailing)).toBe(true);
    expect(decodeScope(asciiTrailing)).toEqual({
      actor: { type: "user", id: "usr_42" },
      context: null,
      actorSource: "comment",
    });

    // Non-ASCII Unicode whitespace (\u00A0, \u2028, \u2029, \uFEFF) is lexed as an identifier by
    // PostgreSQL scan.l and NOT trimmed by resolve_actor(), so it MUST NOT suppress tagging.
    for (const nonAsciiTail of [
      `INSERT INTO invoice(status) VALUES ('ok') RETURNING id /*auditstream='${validTag}'*/\u00A0`,
      `UPDATE t SET v = 1 /*auditstream='${validTag}'*/\u00A0; `,
      `SELECT 1 /*auditstream='${validTag}'*/\u2028`,
      `SELECT 1 /*auditstream='${validTag}'*/\uFEFF`,
    ]) {
      expect(isTagged(nonAsciiTail), `isTagged(${nonAsciiTail})`).toBe(false);
      expect(decodeScope(nonAsciiTail), `decodeScope(${nonAsciiTail})`).toEqual({
        actor: null,
        context: null,
        actorSource: null,
      });
    }

    // Long SQL > 4096 chars: untagged vs tagged at end vs comment buried before the 4096-char tail.
    const padding = " ".repeat(5000);
    const longUntagged = `SELECT 1${padding}FROM invoice WHERE id = $1`;
    expect(isTagged(longUntagged)).toBe(false);
    expect(decodeScope(longUntagged).actorSource).toBeNull();

    const longTagged = `${longUntagged} /*auditstream='${validTag}'*/;`;
    expect(isTagged(longTagged)).toBe(true);
    expect(decodeScope(longTagged).actor).toEqual({ type: "user", id: "usr_42" });

    // Comment whose opening `/*` falls before the last 4096 Unicode code points is outside the tail window.
    const oversizedComment = `SELECT 1 /*${"a".repeat(4100)},auditstream='${validTag}'*/`;
    expect(isTagged(oversizedComment)).toBe(false);
    expect(decodeScope(oversizedComment).actorSource).toBeNull();

    // Astral Unicode characters count as 1 code point each in PostgreSQL right(current_query(), 4096)
    // even when their UTF-16 code-unit length exceeds 4096.
    const astralWithin4096CodePoints = `SELECT '${"x".repeat(2000)}' /*note='${"🚀".repeat(2000)}',auditstream='${validTag}'*/`;
    expect(isTagged(astralWithin4096CodePoints)).toBe(true);
    expect(decodeScope(astralWithin4096CodePoints).actor).toEqual({ type: "user", id: "usr_42" });
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
      { type: "user", id: "u\0b" },
      { type: "user", id: "u\ud800" },
      { type: "user", id: "u1", tenant: "org\0" },
      { type: "ai_agent", id: "a1", onBehalfOf: { type: "user", id: "u\udfff" } },
      { type: "user", id: "u1", context: { requestId: "req\0" } },
      { type: "user", id: "u1", extra: [{ label: "\ud800" }] },
      { type: "user", id: "u1", context: { labels: { "k\0": 1 } } },
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
          type: "user",
          id: "u_📦\\u0000",
          context: { source: "🚀\\udfff" },
        }),
      ),
    ).toEqual({
      actor: { type: "user", id: "u_📦\\u0000" },
      context: { source: "🚀\\udfff" },
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

  it("rejects prototype-hijacking keys (__proto__, constructor, prototype) in decodeScope and canonical encoders", () => {
    const toRawCommentSql = (rawJson: string): string => {
      const b64 = Buffer.from(rawJson, "utf8").toString("base64url");
      return `UPDATE invoice SET status = 'ok' /*auditstream='${b64}'*/`;
    };

    const dangerousRawPayloads: readonly string[] = [
      '{"type":"user","id":"u1","__proto__":{"tenant":"evil","polluted":true}}',
      '{"type":"user","id":"u1","constructor":{"prototype":{"polluted":true}}}',
      '{"type":"user","id":"u1","prototype":{"polluted":true}}',
      '{"type":"ai_agent","id":"a1","onBehalfOf":{"type":"user","id":"u1","__proto__":{"tenant":"evil"}}}',
      '{"type":"ai_agent","id":"a1","onBehalfOf":{"type":"user","id":"u1","constructor":"bad"}}',
      '{"type":"user","id":"u1","context":{"requestId":"r1","__proto__":{"source":"evil"}}}',
      '{"type":"user","id":"u1","context":{"prototype":"bad"}}',
      '{"type":"user","id":"u1","extra":[{"__proto__":{"polluted":true}}]}',
      '{"type":"user","id":"u1","context":{"nested":{"constructor":{"x":1}}}}',
      '{"type":"user","id":"u1","\\u005f\\u005fproto\\u005f\\u005f":{"tenant":"evil"}}',
      '{"type":"user","id":"u1","\\u0063onstructor":{"x":1}}',
      '{"type":"user","id":"u1","\\u0070rototype":{"x":1}}',
    ];

    for (const rawJson of dangerousRawPayloads) {
      expect(decodeScope(toRawCommentSql(rawJson)), rawJson).toEqual({
        actor: null,
        context: null,
        actorSource: "invalid",
      });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const invalidActorScopes: readonly AuditScope[] = [
      {
        actor: JSON.parse(
          '{"type":"user","id":"u1","__proto__":{"tenant":"evil","toJSON":"hijack"}}',
        ) as Actor,
      },
      { actor: JSON.parse('{"type":"user","id":"u1","constructor":{"x":1}}') as Actor },
      { actor: JSON.parse('{"type":"user","id":"u1","prototype":{"x":1}}') as Actor },
      {
        actor: {
          type: "ai_agent",
          id: "a1",
          onBehalfOf: JSON.parse(
            '{"type":"user","id":"u1","__proto__":{"tenant":"evil"}}',
          ) as NestedActor,
        },
      },
      {
        actor: {
          type: "user",
          id: "u1",
          extra: [JSON.parse('{"__proto__":{"x":1}}')],
        } as unknown as Actor,
      },
      {
        actor: Object.assign(Object.create({ tenant: "spoofed" }) as Record<string, unknown>, {
          type: "user",
          id: "u1",
        }) as unknown as Actor,
      },
      {
        actor: {
          type: "ai_agent",
          id: "a1",
          onBehalfOf: Object.assign(
            Object.create({ tenant: "spoofed" }) as Record<string, unknown>,
            { type: "user", id: "u1" },
          ) as unknown as NestedActor,
        },
      },
    ];

    for (const scope of invalidActorScopes) {
      expect(() => encodeScope(scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_ACTOR" }),
      );
      expect(() => setConfigValue(scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_ACTOR" }),
      );
      expect(() => tagSql("SELECT 1", scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_ACTOR" }),
      );
    }

    const invalidContextScopes: readonly AuditScope[] = [
      {
        actor: { type: "user", id: "u1" },
        context: JSON.parse('{"requestId":"r1","__proto__":{"source":"evil"}}') as AuditContext,
      },
      {
        actor: { type: "user", id: "u1" },
        context: JSON.parse('{"constructor":{"x":1}}') as AuditContext,
      },
      {
        actor: { type: "user", id: "u1" },
        context: JSON.parse('{"nested":{"prototype":1}}') as AuditContext,
      },
      {
        actor: { type: "user", id: "u1" },
        context: Object.assign(Object.create({ source: "spoofed" }) as Record<string, unknown>, {
          requestId: "r1",
        }) as unknown as AuditContext,
      },
    ];

    for (const scope of invalidContextScopes) {
      expect(() => encodeScope(scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_CONTEXT" }),
      );
      expect(() => setConfigValue(scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_CONTEXT" }),
      );
      expect(() => tagSql("SELECT 1", scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_CONTEXT" }),
      );
    }

    // Null-prototype plain objects without forbidden keys remain valid.
    const nullProtoActor = Object.assign(Object.create(null) as Record<string, unknown>, {
      type: "user",
      id: "usr_null_proto",
    }) as unknown as Actor;
    const nullProtoContext = Object.assign(Object.create(null) as Record<string, unknown>, {
      requestId: "req_null_proto",
    }) as unknown as AuditContext;
    const json = setConfigValue({ actor: nullProtoActor, context: nullProtoContext });
    expect(json).toBe(
      '{"type":"user","id":"usr_null_proto","context":{"requestId":"req_null_proto"}}',
    );

    // Null-prototype objects WITH forbidden keys are still rejected.
    const badNullProtoActor = Object.create(null) as Record<string, unknown>;
    badNullProtoActor.type = "user";
    badNullProtoActor.id = "u1";
    Object.defineProperty(badNullProtoActor, "__proto__", {
      value: { tenant: "evil" },
      enumerable: true,
    });
    expect(() => encodeScope({ actor: badNullProtoActor as unknown as Actor })).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );

    // Export record parser sharing isValidActorObject/isValidContextObject also rejects forbidden keys.
    const baseExportRecord = {
      schema_version: 1,
      id: "1",
      event_id: "019a0000-0000-7000-8000-000000000001",
      occurred_at: "2026-11-25T10:00:00.000000Z",
      xact_id: "100",
      source: "db",
      op: "UPDATE",
      schema_name: "public",
      table_name: "invoice",
      table_oid: 16384,
      record_id: { id: "inv_1" },
      before: { status: "open" },
      after: { status: "paid" },
      changed: ["status"],
      actor: { type: "user", id: "u1" },
      actor_source: "comment",
      context: { requestId: "req_1" },
      db_user: "app_user",
    };
    expect(() => parseExportRecord(JSON.stringify(baseExportRecord))).not.toThrow();

    const protoActorLine = JSON.stringify(baseExportRecord).replace(
      '"actor":{"type":"user","id":"u1"}',
      '"actor":{"type":"user","id":"u1","__proto__":{"tenant":"evil"}}',
    );
    const protoContextLine = JSON.stringify(baseExportRecord).replace(
      '"context":{"requestId":"req_1"}',
      '"context":{"requestId":"req_1","constructor":{"x":1}}',
    );
    expect(() => parseExportRecord(protoActorLine)).toThrowError(
      expect.objectContaining({
        code: "INVALID_RECORD",
        message: expect.stringContaining("actor must be null or conform"),
      }),
    );
    expect(() => parseExportRecord(protoContextLine)).toThrowError(
      expect.objectContaining({
        code: "INVALID_RECORD",
        message: expect.stringContaining("context must be null or a JSON object"),
      }),
    );

    // Mutating returned absent/invalid decode objects must never poison subsequent calls.
    const absentResult = decodeScope("SELECT 1") as unknown as Record<string, unknown>;
    absentResult.actorSource = "comment";
    absentResult.actor = { type: "user", id: "hijacked" };
    expect(decodeScope("SELECT 2")).toEqual({ actor: null, context: null, actorSource: null });
    expect(isTagged("SELECT 2")).toBe(false);

    const invalidResult = decodeScope("SELECT 1 /*auditstream='bad'*/") as unknown as Record<
      string,
      unknown
    >;
    invalidResult.actorSource = "comment";
    expect(decodeScope("SELECT 2 /*auditstream='bad'*/")).toEqual({
      actor: null,
      context: null,
      actorSource: "invalid",
    });

    // toJSON() methods on actor, onBehalfOf, or context must not hijack serialization,
    // and circular / BigInt extension values must throw AuditstreamError (never uncaught TypeError).
    const circularActor: Record<string, unknown> = { type: "user", id: "u1" };
    circularActor.self = circularActor;
    const circularContext: Record<string, unknown> = { requestId: "r1" };
    circularContext.self = circularContext;

    const hijackActorScopes: readonly AuditScope[] = [
      {
        actor: {
          type: "user",
          id: "u1",
          toJSON: () => ({ type: "service", id: "spoofed" }),
        } as unknown as Actor,
      },
      {
        actor: { type: "user", id: "u1", toJSON: () => null } as unknown as Actor,
      },
      {
        actor: { type: "user", id: "u1", toJSON: () => undefined } as unknown as Actor,
      },
      {
        actor: {
          type: "ai_agent",
          id: "a1",
          onBehalfOf: {
            type: "user",
            id: "u1",
            toJSON: () => ({ type: "bot", id: "" }),
          },
        } as unknown as Actor,
      },
      {
        actor: {
          type: "user",
          id: "u1",
          extra: { toJSON: () => JSON.parse('{"__proto__":{"x":1}}') },
        } as unknown as Actor,
      },
      { actor: circularActor as unknown as Actor },
      { actor: { type: "user", id: "u1", big: 1n } as unknown as Actor },
    ];

    for (const scope of hijackActorScopes) {
      expect(() => setConfigValue(scope)).toThrowError(AuditstreamError);
      expect(() => setConfigValue(scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_ACTOR" }),
      );
      expect(() => encodeScope(scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_ACTOR" }),
      );
    }

    let oneShotThrew = false;
    const oneShotContext = {
      requestId: "r1",
      extra: {
        toJSON(): string {
          if (!oneShotThrew) {
            oneShotThrew = true;
            throw new Error("one-shot context failure");
          }
          return "ok";
        },
      },
    } as unknown as AuditContext;

    const hijackContextScopes: readonly AuditScope[] = [
      {
        actor: { type: "user", id: "u1" },
        context: {
          requestId: "r1",
          toJSON: () => "not-an-object",
        } as unknown as AuditContext,
      },
      {
        actor: { type: "user", id: "u1" },
        context: circularContext as unknown as AuditContext,
      },
      {
        actor: { type: "user", id: "u1" },
        context: { requestId: "r1", big: 1n } as unknown as AuditContext,
      },
      {
        actor: { type: "user", id: "u1" },
        context: oneShotContext,
      },
    ];

    let oneShotActorThrew = false;
    const oneShotActorScope: AuditScope = {
      actor: {
        type: "user",
        id: "u1",
        extra: {
          toJSON(): string {
            if (!oneShotActorThrew) {
              oneShotActorThrew = true;
              throw new Error("one-shot actor failure");
            }
            return "ok";
          },
        },
      } as unknown as Actor,
      context: { requestId: "r1" },
    };
    expect(() => setConfigValue(oneShotActorScope)).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );

    // Throwing getters in actor/context and non-object scope must convert to AuditstreamError.
    const throwingActorGetter = {
      type: "user",
      id: "u1",
      extra: {
        get boom(): string {
          throw new Error("actor getter boom");
        },
      },
    } as unknown as Actor;
    const throwingContextGetter = {
      requestId: "r1",
      extra: {
        get boom(): string {
          throw new Error("context getter boom");
        },
      },
    } as unknown as AuditContext;
    expect(() => setConfigValue({ actor: throwingActorGetter })).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );
    expect(() =>
      setConfigValue({ actor: { type: "user", id: "u1" }, context: throwingContextGetter }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONTEXT" }));
    const protoBoom = new Proxy(
      { type: "user", id: "u1" },
      {
        getPrototypeOf(): never {
          throw new Error("getPrototypeOf boom");
        },
      },
    );
    const { proxy: revokedProxy, revoke: revokeProxy } = Proxy.revocable(
      { type: "user", id: "u1" },
      {},
    );
    revokeProxy();

    expect(() => setConfigValue({ actor: protoBoom as unknown as Actor })).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );
    expect(() => setConfigValue({ actor: revokedProxy as unknown as Actor })).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );
    expect(() =>
      setConfigValue({
        actor: { type: "user", id: "u1" },
        context: protoBoom as unknown as AuditContext,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONTEXT" }));
    expect(() =>
      setConfigValue({
        actor: { type: "user", id: "u1" },
        context: revokedProxy as unknown as AuditContext,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONTEXT" }));
    expect(() =>
      setConfigValue({
        actor: { type: "user", id: "u1" },
        get context(): AuditContext {
          throw new Error("scope.context boom");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONTEXT" }));

    expect(() => encodeScope(null as unknown as AuditScope)).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );
    expect(() => setConfigValue(null as unknown as AuditScope)).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );
    expect(() => tagSql("SELECT 1", null as unknown as AuditScope)).toThrowError(
      expect.objectContaining({ code: "INVALID_ACTOR" }),
    );

    for (const scope of hijackContextScopes) {
      expect(() => setConfigValue(scope)).toThrowError(
        expect.objectContaining({ code: "INVALID_CONTEXT" }),
      );
    }
  });

  it("tagSql inserts a newline after trailing -- line comments and respects PostgreSQL quoting/nesting", async () => {
    const scope: AuditScope = { actor: { type: "user", id: "usr_42" } };
    const encoded = encodeScope(scope);
    const otherTag = encodeScope({ actor: { type: "user", id: "usr_fake" } });

    const trailingLineCommentQueries = [
      "SELECT 1 -- user note",
      "SELECT 1 --",
      `SELECT 1 -- /*auditstream='${otherTag}'*/`,
      `SELECT 1 /*auditstream='${otherTag}'*/ -- trailing comment`,
      "SELECT $1 -- positional parameter is not dollar-quote",
      "SELECT col$a$ FROM t -- ident dollar is not dollar-quote",
      "SELECT 'backslash \\' -- standard_conforming_strings ends string here",
      "SELECT E'\\\\' -- E-string ended after escaped backslash",
      "SELECT E'a'\n'b\\' ' || 'x' -- trailing comment after E-string quotecontinue",
      "SELECT E'a' -- join\n'b\\' ' || 'x' -- trailing comment after commented E-string continuation",
      'SELECT "col" -- after double-quoted ident',
      "SELECT 1 /* block */ -- line after block",
    ];

    for (const sql of trailingLineCommentQueries) {
      expect(isTagged(sql), `isTagged(${sql})`).toBe(false);
      expect(decodeScope(sql), `decodeScope(${sql})`).toEqual({
        actor: null,
        context: null,
        actorSource: null,
      });

      const tagged = tagSql(sql, scope);
      expect(tagged, `tagSql(${sql})`).toBe(`${sql}\n/*auditstream='${encoded}'*/`);
      expect(isTagged(tagged), `isTagged(tagged: ${sql})`).toBe(true);
      expect(decodeScope(tagged), `decodeScope(tagged: ${sql})`).toEqual({
        actor: { type: "user", id: "usr_42" },
        context: null,
        actorSource: "comment",
      });
      // Calling tagSql again must not double-tag.
      expect(tagSql(tagged, scope)).toBe(tagged);
    }

    // Verify cached audit.as() scopes also insert \n on trailing -- without corrupting normal queries.
    await audit.as(scope.actor, () => {
      expect(tagSql("SELECT 1 -- cached")).toBe(`SELECT 1 -- cached\n/*auditstream='${encoded}'*/`);
      expect(tagSql("SELECT 1")).toBe(`SELECT 1 /*auditstream='${encoded}'*/`);
    });

    const nonTrailingLineCommentQueries = [
      "SELECT 1 -- closed with LF\n",
      "SELECT 1 -- closed with CR\r",
      "SELECT '-- inside single quotes'",
      "SELECT 'it''s -- still in single quotes'",
      "SELECT E'escaped \\' -- still in E-string'",
      'SELECT "col--name" FROM t',
      'SELECT "a""--b" FROM t',
      "SELECT $$-- inside dollar quote$$",
      "SELECT $tag$-- inside tagged dollar quote$tag$",
      "SELECT $a$ $b$ -- inside $a$",
      "SELECT 1 /* -- inside block comment */",
      "SELECT 1 /* outer /* inner */ -- still in outer block */",
    ];

    for (const sql of nonTrailingLineCommentQueries) {
      expect(isTagged(sql), `isTagged(${sql})`).toBe(false);
      const tagged = tagSql(sql, scope);
      expect(tagged, `tagSql(${sql})`).toBe(`${sql} /*auditstream='${encoded}'*/`);
      expect(isTagged(tagged)).toBe(true);
      expect(decodeScope(tagged).actor).toEqual({ type: "user", id: "usr_42" });
    }
  });

  it("isTagged and decodeScope enforce lexical sqlcommenter parsing without suppressing tagging", () => {
    const validTag = "eyJ0eXBlIjoidXNlciIsImlkIjoidXNyXzQyIn0";
    const activeScope: AuditScope = { actor: { type: "user", id: "usr_real" } };

    // Embedded `,auditstream='` in other sqlcommenter values, free-form comments, malformed pairs,
    // or nested/unclosed contexts MUST NOT suppress tagging.
    const nonTaggedQueries = [
      "SELECT 1 /*route='foo,auditstream=',other='bar'*/",
      "SELECT 1 /*note='hello,auditstream=''abc'''*/",
      `SELECT 1 /* free text ,auditstream='${validTag}' */`,
      `SELECT 1 /*garbage,auditstream='${validTag}'*/`,
      `SELECT 1 /*auditstream='${validTag}',*/`,
      `SELECT 1 /*,auditstream='${validTag}'*/`,
      `SELECT 1 /*auditstream='${validTag}',auditstream='${validTag}',garbage*/`,
      `SELECT 1 /* outer /*auditstream='${validTag}'*/ */`,
    ];

    for (const sql of nonTaggedQueries) {
      expect(isTagged(sql), `isTagged(${sql})`).toBe(false);
      expect(decodeScope(sql), `decodeScope(${sql})`).toEqual({
        actor: null,
        context: null,
        actorSource: null,
      });
      const tagged = tagSql(sql, activeScope);
      expect(tagged).not.toBe(sql);
      expect(decodeScope(tagged).actor).toEqual({ type: "user", id: "usr_real" });
    }

    // Comment-like text inside unterminated string or dollar-quoted literals is not a trailing comment.
    for (const unterminated of [
      `SELECT 'unclosed /*auditstream='${validTag}'*/`,
      `SELECT $$unclosed /*auditstream='${validTag}'*/`,
    ]) {
      expect(isTagged(unterminated), `isTagged(${unterminated})`).toBe(false);
      expect(decodeScope(unterminated), `decodeScope(${unterminated})`).toEqual({
        actor: null,
        context: null,
        actorSource: null,
      });
    }

    // Structurally or semantically invalid auditstream tag values (padded, >683 chars, len%4===1,
    // duplicate key, non-JSON, invalid UTF-8, invalid actor schema, or earlier `,auditstream=`
    // value colliding with PG resolve_actor()'s strpos()) do not suppress tagging (isTagged === false)
    // while decodeScope reports invalid.
    const invalidAuditstreamTags = [
      `SELECT 1 /*auditstream='${validTag}='*/`,
      `SELECT 1 /*auditstream='${"a".repeat(684)}'*/`,
      "SELECT 1 /*auditstream='a'*/",
      `SELECT 1 /*auditstream='${validTag}',auditstream='${validTag}'*/`,
      `UPDATE invoice SET status = 'ok' /*x='foo,auditstream=',auditstream='${validTag}'*/`,
      "SELECT 1 /*auditstream='bm90IGpzb24'*/",
      "SELECT 1 /*auditstream='__79'*/",
      "SELECT 1 /*auditstream='eyJ0eXBlIjoiYm90IiwiaWQiOiJiMSJ9'*/",
    ];

    for (const sql of invalidAuditstreamTags) {
      expect(isTagged(sql), `isTagged(${sql})`).toBe(false);
      expect(decodeScope(sql), `decodeScope(${sql})`).toEqual({
        actor: null,
        context: null,
        actorSource: "invalid",
      });
      const tagged = tagSql(sql, activeScope);
      expect(isTagged(tagged)).toBe(true);
      expect(decodeScope(tagged).actor).toEqual({ type: "user", id: "usr_real" });
    }

    // Valid sqlcommenter with a comma inside another quoted value, Drizzle 1.x dotted/percent keys
    // and escaped apostrophes (`\'`), or multi-line E'...' quotecontinue still recognize auditstream.
    for (const validSql of [
      `SELECT 1 /*route='a,b',auditstream='${validTag}'*/`,
      `SELECT 1 /*app.route='%2Fusers',auditstream='${validTag}'*/`,
      `SELECT 1 /*k%2520v='1',auditstream='${validTag}'*/`,
      `SELECT 1 /*auditstream='${validTag}',route='O\\'Reilly'*/`,
      `SELECT 1 /*route='O\\'Reilly',auditstream='${validTag}'*/`,
      `SELECT 1 /*route='foo\\\\',auditstream='${validTag}'*/`,
      `SELECT 1 /*x='foo\\',auditstream='${validTag}'*/`,
      `SELECT 1 /*auditstream='${validTag}',x='foo\\'*/`,
      `SELECT 1 /*x='a\\',b='c',auditstream='${validTag}'*/`,
      `SELECT E'a'\n'b\\' ' || 'x' /*auditstream='${validTag}'*/`,
      `SELECT 1 -- note\n/*auditstream='${validTag}'*/;`,
    ]) {
      expect(isTagged(validSql), `isTagged(${validSql})`).toBe(true);
      expect(decodeScope(validSql), `decodeScope(${validSql})`).toEqual({
        actor: { type: "user", id: "usr_42" },
        context: null,
        actorSource: "comment",
      });
    }
  });

  it("decodeScope rejects NUL and unpaired UTF-16 surrogates even inside shadowed duplicate JSON keys", () => {
    const toRawCommentSql = (rawJson: string): string => {
      const b64 = Buffer.from(rawJson, "utf8").toString("base64url");
      return `UPDATE invoice SET status = 'ok' /*auditstream='${b64}'*/`;
    };

    for (const rawJson of [
      '{"id":"bad\\u0000","id":"u1","type":"user"}',
      '{"x":"\\u0000","x":"ok","type":"user","id":"u1"}',
      '{"k\\u0000":"v","type":"user","id":"u1"}',
      '{"x":"\\ud800","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\udfff","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\udfff\\ud800","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\ud83d\\ude80\\ud800","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\ud83d\\ud83d\\ude80","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\ud83d😀","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\ud83d\\u0041","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\uD800","x":"ok","type":"user","id":"u1"}',
      '{"x":"a\\\\\\u0000","x":"ok","type":"user","id":"u1"}',
      '{"x":"\\"\\u0000","x":"ok","type":"user","id":"u1"}',
    ]) {
      expect(decodeScope(toRawCommentSql(rawJson)), rawJson).toEqual({
        actor: null,
        context: null,
        actorSource: "invalid",
      });
    }

    // Valid surrogate pair + literal escaped \\u0000 / \\ud800 inside shadowed duplicate key stays valid.
    const validRaw = '{"x":"\\ud83d\\ude80\\\\u0000\\\\ud800","x":"ok","type":"user","id":"u1"}';
    expect(decodeScope(toRawCommentSql(validRaw))).toEqual({
      actor: { type: "user", id: "u1", x: "ok" },
      context: null,
      actorSource: "comment",
    });
  });

  it("decodeScope and isTagged reject UTF-8 BOM and PostgreSQL numeric-overflow JSON numbers", () => {
    const activeScope: AuditScope = { actor: { type: "user", id: "usr_real" } };
    const toRawCommentSql = (rawJson: string): string => {
      const b64 = Buffer.from(rawJson, "utf8").toString("base64url");
      return `UPDATE invoice SET status = 'paid' /*auditstream='${b64}'*/`;
    };

    // Leading UTF-8 BOM (0xEF 0xBB 0xBF) is preserved by PostgreSQL convert_from() and rejected by ::jsonb.
    const bomBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"type":"user","id":"u1"}', "utf8"),
    ]);
    const bomSql = `UPDATE invoice SET status = 'paid' /*auditstream='${bomBytes.toString("base64url")}'*/`;
    expect(isTagged(bomSql)).toBe(false);
    expect(decodeScope(bomSql)).toEqual({
      actor: null,
      context: null,
      actorSource: "invalid",
    });
    expect(decodeScope(tagSql(bomSql, activeScope)).actor).toEqual({
      type: "user",
      id: "usr_real",
    });

    // JSON numbers overflowing PostgreSQL numeric (weight > 32767, dscale > 16383, or |exp| >= INT_MAX/2),
    // including inside shadowed duplicate keys, must yield actorSource: "invalid" and isTagged === false.
    for (const rawJson of [
      '{"type":"user","id":"u1","x":1e1000000}',
      '{"type":"user","id":"u1","x":1e131072}',
      '{"type":"user","id":"u1","x":-1e131072}',
      '{"type":"user","id":"u1","x":0.0001e131076}',
      '{"type":"user","id":"u1","x":1e-16384}',
      '{"type":"user","id":"u1","x":0.1e-16383}',
      '{"type":"user","id":"u1","x":0e-16384}',
      '{"type":"user","id":"u1","x":0e1073741823}',
      '{"x":1e1000000,"x":1,"type":"user","id":"u1"}',
    ]) {
      const sql = toRawCommentSql(rawJson);
      expect(isTagged(sql), `isTagged(${rawJson})`).toBe(false);
      expect(decodeScope(sql), `decodeScope(${rawJson})`).toEqual({
        actor: null,
        context: null,
        actorSource: "invalid",
      });
      expect(decodeScope(tagSql(sql, activeScope)).actor).toEqual({
        type: "user",
        id: "usr_real",
      });
    }

    // In-range scientific notation (at exact PG numeric boundaries) remains valid.
    for (const rawJson of [
      '{"type":"user","id":"u1","x":1e131071}',
      '{"type":"user","id":"u1","x":0.0001e131075}',
      '{"type":"user","id":"u1","x":1e-16383}',
      '{"type":"user","id":"u1","x":0e1000000}',
      '{"type":"user","id":"u1","x":-42.5E10,"note":"1e999999"}',
    ]) {
      const sql = toRawCommentSql(rawJson);
      expect(isTagged(sql), `isTagged(${rawJson})`).toBe(true);
      expect(decodeScope(sql).actorSource, `decodeScope(${rawJson})`).toBe("comment");
    }
  });
});
