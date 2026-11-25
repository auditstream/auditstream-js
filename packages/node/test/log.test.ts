import { describe, expect, it, vi } from "vitest";
import {
  type AuditLogEvent,
  type AuditLogExecutor,
  type AuditLogValues,
  AuditstreamError,
  audit,
  LOG_EVENT_SQL,
  MAX_ACTION_LENGTH,
} from "../src/index.js";

describe("audit.log()", () => {
  it("sends exactly one parameterized SELECT auditstream.log_event($1::text, $2::jsonb, $3::jsonb) statement", async () => {
    const calls: Array<{ text: string; values: AuditLogValues }> = [];
    const exec: AuditLogExecutor = async (text, values) => {
      calls.push({ text, values });
      return { rows: [{ log_event: "0194e4c2-8a4f-7000-8000-000000000001" }], rowCount: 1 };
    };

    const result = await audit.log(exec, {
      action: "invoice.sent",
      target: { invoiceId: 42, tenant: "org_acme" },
      data: { channel: "email", note: "'; DROP TABLE auditstream.changes; --" },
    });

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe(LOG_EVENT_SQL);
    expect(calls[0]?.text).toBe("SELECT auditstream.log_event($1::text, $2::jsonb, $3::jsonb)");
    expect(calls[0]?.values).toEqual([
      "invoice.sent",
      '{"invoiceId":42,"tenant":"org_acme"}',
      '{"channel":"email","note":"\'; DROP TABLE auditstream.changes; --"}',
    ]);
    // Verify values are never interpolated into the SQL string.
    expect(calls[0]?.text).not.toContain("invoice.sent");
    expect(calls[0]?.text).not.toContain("DROP TABLE");
  });

  it("sends SQL NULL parameters when target or data are omitted or null", async () => {
    const received: AuditLogValues[] = [];
    const exec: AuditLogExecutor = async (_text, values) => {
      received.push(values);
    };

    await audit.log(exec, { action: "user.logout" });
    await audit.log(exec, { action: "user.logout", target: null, data: null });
    await audit.log(exec, { action: "user.logout", target: undefined, data: undefined });

    expect(received).toEqual([
      ["user.logout", null, null],
      ["user.logout", null, null],
      ["user.logout", null, null],
    ]);
  });

  it("executes inside the caller's active audit.as() scope so executors see audit.current()", async () => {
    const observed: Array<{
      action: string;
      actorId: string | undefined;
      requestId: string | undefined;
    }> = [];

    const exec: AuditLogExecutor = async (_text, values) => {
      const scope = audit.current();
      observed.push({
        action: values[0],
        actorId: scope?.actor.id,
        requestId: scope?.context?.requestId,
      });
    };

    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        audit.as(
          { type: "user", id: `usr_${i}` },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, (i * 5) % 13));
            await audit.log(exec, {
              action: `event.${i}`,
              target: { seq: i },
            });
          },
          { context: { requestId: `req_${i}`, source: "api" } },
        ),
      ),
    );

    expect(observed).toHaveLength(40);
    for (const entry of observed) {
      const seq = entry.action.slice("event.".length);
      expect(entry.actorId).toBe(`usr_${seq}`);
      expect(entry.requestId).toBe(`req_${seq}`);
    }
  });

  it("still calls exec outside any audit.as() scope with audit.current() undefined", async () => {
    let seenScope: unknown = "sentinel";
    const exec: AuditLogExecutor = async () => {
      seenScope = audit.current();
    };

    expect(audit.current()).toBeUndefined();
    const res = await audit.log(exec, { action: "system.cleanup" });
    expect(res).toBeUndefined();
    expect(seenScope).toBeUndefined();
  });

  it("accepts 64-codepoint actions including multi-byte Unicode characters", async () => {
    const exec = vi.fn<AuditLogExecutor>().mockResolvedValue(undefined);
    const sixtyFourEmoji = "🔥".repeat(MAX_ACTION_LENGTH);
    expect([...sixtyFourEmoji]).toHaveLength(64);
    expect(sixtyFourEmoji.length).toBe(128);

    await audit.log(exec, { action: sixtyFourEmoji });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(LOG_EVENT_SQL, [sixtyFourEmoji, null, null]);
  });

  it("allows valid supplementary Unicode and literal \\u escape text in action, target, and data", async () => {
    const exec = vi.fn<AuditLogExecutor>().mockResolvedValue(undefined);
    await audit.log(exec, {
      action: "invoice.📦",
      target: { id: "a\\u0000" },
      data: { label: "🚀\\ud800" },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(LOG_EVENT_SQL, [
      "invoice.📦",
      '{"id":"a\\\\u0000"}',
      '{"label":"🚀\\\\ud800"}',
    ]);
  });

  it("rejects spec-invalid inputs with AuditstreamError before calling exec", async () => {
    const exec = vi.fn<AuditLogExecutor>();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const invalidCases: Array<[string, unknown]> = [
      ["empty action", { action: "" }],
      ["whitespace-only action", { action: "   \t\n" }],
      ["65 ASCII char action", { action: "a".repeat(65) }],
      ["65 Unicode code point action", { action: "🔥".repeat(65) }],
      ["reserved INSERT", { action: "INSERT" }],
      ["reserved lowercase insert", { action: "insert" }],
      ["reserved mixed-case Update", { action: "Update" }],
      ["reserved DELETE", { action: "DELETE" }],
      ["reserved lowercase truncate", { action: "truncate" }],
      ["reserved padded action", { action: " delete " }],
      ["non-string action", { action: 123 }],
      ["null event", null],
      ["array event", []],
      ["primitive target", { action: "invoice.sent", target: "inv_1" }],
      ["array target", { action: "invoice.sent", target: [1, 2] }],
      ["primitive data", { action: "invoice.sent", data: 42 }],
      ["array data", { action: "invoice.sent", data: ["x"] }],
      ["circular target", { action: "invoice.sent", target: circular }],
      ["BigInt in data", { action: "invoice.sent", data: { amount: 10n } }],
      [
        "toJSON returning non-object",
        {
          action: "invoice.sent",
          data: {
            toJSON() {
              return "scalar";
            },
          },
        },
      ],
      ["NUL in action", { action: "invoice.\0sent" }],
      ["unpaired high surrogate in action", { action: "invoice.\ud800" }],
      ["unpaired low surrogate in action", { action: "invoice.\udfff" }],
      ["NUL in target value", { action: "invoice.sent", target: { id: "a\0b" } }],
      ["unpaired surrogate in target key", { action: "invoice.sent", target: { "\ud800": 1 } }],
      ["NUL in nested data value", { action: "invoice.sent", data: { nested: ["ok", "a\0b"] } }],
      [
        "unpaired surrogate in nested data key",
        { action: "invoice.sent", data: { nested: { "\udfff": true } } },
      ],
      [
        "NUL returned by data.toJSON()",
        {
          action: "invoice.sent",
          data: {
            toJSON() {
              return { note: "bad\0" };
            },
          },
        },
      ],
    ];

    for (const [label, input] of invalidCases) {
      await expect(
        audit.log(exec, input as AuditLogEvent),
        `expected rejection for ${label}`,
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof AuditstreamError && err.code === "INVALID_EVENT",
      );
    }

    await expect(
      audit.log(null as unknown as AuditLogExecutor, { action: "invoice.sent" }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof AuditstreamError && err.code === "INVALID_EVENT",
    );

    expect(exec).not.toHaveBeenCalled();
  });

  it("propagates asynchronous and synchronous errors from exec unchanged", async () => {
    const asyncBoom = Object.assign(new Error("connection reset"), { code: "08006" });
    await expect(
      audit.log(
        async () => {
          throw asyncBoom;
        },
        { action: "invoice.sent" },
      ),
    ).rejects.toBe(asyncBoom);

    const syncBoom = Object.assign(new Error("pool closed"), { code: "EPOOL" });
    await expect(
      audit.log(
        () => {
          throw syncBoom;
        },
        { action: "invoice.sent" },
      ),
    ).rejects.toBe(syncBoom);
  });

  it("supports README one-liner executor shapes without readonly tuple friction", async () => {
    const fakePool = {
      query: vi.fn((_text: string, _values?: unknown[]) => Promise.resolve({ rowCount: 1 })),
    };
    const fakePrisma = {
      $executeRawUnsafe: vi.fn((_query: string, ..._values: unknown[]) => Promise.resolve(1)),
    };

    await audit.log((t, v) => fakePool.query(t, v), {
      action: "invoice.sent",
      target: { id: 1 },
    });
    await audit.log((t, v) => fakePrisma.$executeRawUnsafe(t, ...v), {
      action: "invoice.paid",
      data: { paid: true },
    });

    expect(fakePool.query).toHaveBeenCalledWith(LOG_EVENT_SQL, ["invoice.sent", '{"id":1}', null]);
    expect(fakePrisma.$executeRawUnsafe).toHaveBeenCalledWith(
      LOG_EVENT_SQL,
      "invoice.paid",
      null,
      '{"paid":true}',
    );
  });
});
