import { audit, setConfigValue } from "@auditstream/node";
import { describe, expect, it } from "vitest";
import {
  auditTransaction,
  type PrismaRawExecutor,
  type PrismaTransactionRunner,
} from "../src/index.js";

interface RecordedRawCall {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

interface FakeTx extends PrismaRawExecutor {
  readonly calls: RecordedRawCall[];
  readonly work: () => string;
}

interface FakeTxOptions {
  readonly maxWait?: number;
  readonly timeout?: number;
  readonly isolationLevel?: "ReadCommitted" | "Serializable";
}

function createFakePrisma(deferOutsideAls = false): {
  prisma: PrismaTransactionRunner<FakeTx, FakeTxOptions>;
  txCalls: RecordedRawCall[];
  receivedOptions: Array<FakeTxOptions | undefined>;
  argCounts: number[];
} {
  const txCalls: RecordedRawCall[] = [];
  const receivedOptions: Array<FakeTxOptions | undefined> = [];
  const argCounts: number[] = [];

  const tx: FakeTx = {
    calls: txCalls,
    async $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number> {
      txCalls.push({ strings: [...query], values });
      return 1;
    },
    work(): string {
      return "tx-result";
    },
  };

  const prisma: PrismaTransactionRunner<FakeTx, FakeTxOptions> = {
    async $transaction<TResult>(
      fn: (t: FakeTx) => Promise<TResult>,
      ...rest: [FakeTxOptions?]
    ): Promise<TResult> {
      argCounts.push(1 + rest.length);
      receivedOptions.push(rest[0]);
      if (deferOutsideAls) {
        return await new Promise<TResult>((resolve, reject) => {
          setImmediate(() => {
            fn(tx).then(resolve, reject);
          });
        });
      }
      return await fn(tx);
    },
  };

  return { prisma, txCalls, receivedOptions, argCounts };
}

describe("auditTransaction() set_config fallback", () => {
  it("runs SELECT set_config('auditstream.actor', $1, true) with bound setConfigValue() first and returns fn's result", async () => {
    const { prisma, txCalls, receivedOptions, argCounts } = createFakePrisma();
    const actor = {
      type: "ai_agent" as const,
      id: "billing-agent",
      onBehalfOf: { type: "user" as const, id: "u_42" },
    };
    const context = { requestId: "req_1", source: "api" };
    const order: string[] = [];

    const result = await audit.as(
      actor,
      () =>
        auditTransaction(
          prisma,
          async (tx) => {
            order.push(`body:rawCalls=${tx.calls.length}`);
            return tx.work();
          },
          { maxWait: 2000, timeout: 5000, isolationLevel: "Serializable" },
        ),
      { context },
    );

    expect(result).toBe("tx-result");
    expect(order).toEqual(["body:rawCalls=1"]);
    expect(argCounts).toEqual([2]);
    expect(receivedOptions).toEqual([
      { maxWait: 2000, timeout: 5000, isolationLevel: "Serializable" },
    ]);

    expect(txCalls).toHaveLength(1);
    const call = txCalls[0];
    // SQL template keeps parameter placeholder separate — payload is bound, never interpolated into SQL text.
    expect(call?.strings).toEqual(["SELECT set_config('auditstream.actor', ", ", true)"]);
    expect(call?.values).toEqual([setConfigValue({ actor, context })]);
    expect(call?.strings.join("")).not.toContain("billing-agent");
  });

  it("runs fn inside $transaction without calling set_config when outside any audit.as() scope", async () => {
    const { prisma, txCalls, argCounts } = createFakePrisma();

    const result = await auditTransaction(prisma, async (tx) => {
      return `${tx.work()}:unscoped`;
    });

    expect(result).toBe("tx-result:unscoped");
    expect(txCalls).toEqual([]);
    expect(argCounts).toEqual([1]);
  });

  it("captures the active actor at entry even if the pool defers invoking the callback", async () => {
    const { prisma, txCalls } = createFakePrisma(true);
    const actor = { type: "user" as const, id: "captured-at-entry" };

    const result = await audit.as(actor, () => auditTransaction(prisma, async (tx) => tx.work()));

    expect(result).toBe("tx-result");
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0]?.values).toEqual([setConfigValue({ actor })]);
  });

  it("propagates errors thrown by fn unchanged", async () => {
    const { prisma } = createFakePrisma();
    const boom = new Error("business rule failed");

    await expect(
      audit.as({ type: "user", id: "u_err" }, () =>
        auditTransaction(prisma, async () => {
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);
  });
});
