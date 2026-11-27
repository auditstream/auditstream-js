import { audit, setConfigValue } from "@auditstream/node";

/**
 * Interactive transaction client capable of executing parameterized tagged SQL via `$executeRaw`.
 */
export interface PrismaRawExecutor {
  /** Executes a parameterized SQL template string on the active transaction connection. */
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

/**
 * Structural shape of a Prisma client supporting interactive `$transaction(fn, options?)`.
 */
export interface PrismaTransactionRunner<TTx extends PrismaRawExecutor, TOptions = unknown> {
  /** Runs `fn` inside an interactive database transaction with optional Prisma transaction options. */
  $transaction<TResult>(fn: (tx: TTx) => Promise<TResult>, options?: TOptions): Promise<TResult>;
}

/**
 * Runs `fn` inside a Prisma interactive transaction (`prisma.$transaction`) and, when an
 * `audit.as()` scope is active at call time, executes
 * `SELECT set_config('auditstream.actor', $1, true)` as the transaction's first statement
 * using a bound parameter from `setConfigValue()`.
 *
 * - **When to use:** Use `auditTransaction()` when SQL comments cannot reach PostgreSQL
 *   (notably under Prisma Accelerate, where comment plugins do not receive SQL and comment
 *   delivery is undocumented).
 * - **Precedence & isolation:** `set_config('auditstream.actor', $1, true)` is transaction-local
 *   (`is_local = true`), wins over any SQL comment on the same statement, and resets to an empty
 *   string once the transaction commits or rolls back so actors cannot leak across pooled
 *   connections.
 * - **Nested `audit.as()` scopes:** `auditTransaction()` captures `audit.current()` once at
 *   transaction entry and runs `set_config('auditstream.actor', $1, true)` once at transaction
 *   start. Because `set_config` takes precedence over SQL comments (`spec/transport.md`), nested
 *   `audit.as(innerActor, ...)` calls inside `fn(tx)` still attribute database writes on `tx` to
 *   the outer transaction's actor. Run the inner work in a separate transaction (or explicitly
 *   update and restore `auditstream.actor` via `setConfigValue()` and `set_config(..., true)` on
 *   `tx`) if an inner step must be attributed to a different actor.
 * - **RDS Proxy note:** `set_config` pins connections on AWS RDS Proxy; keep the `auditstream()`
 *   SQL comments plugin as the default transport there.
 * - **Outside a scope:** When `audit.current()` is `undefined`, `auditTransaction()` runs `fn`
 *   inside `prisma.$transaction` without issuing `set_config`.
 *
 * @example
 * ```ts
 * import { audit } from "@auditstream/node";
 * import { auditTransaction } from "@auditstream/prisma";
 *
 * const updated = await audit.as({ type: "user", id: "usr_1" }, () =>
 *   auditTransaction(
 *     prisma,
 *     async (tx) => tx.invoice.update({ where: { id: 1 }, data: { status: "paid" } }),
 *     { timeout: 10_000 },
 *   ),
 * );
 * ```
 */
export async function auditTransaction<TTx extends PrismaRawExecutor, TResult, TOptions = unknown>(
  prisma: PrismaTransactionRunner<TTx, TOptions>,
  fn: (tx: TTx) => Promise<TResult>,
  options?: TOptions,
): Promise<TResult> {
  // Capture the active actor synchronously at call entry before `$transaction` queues or acquires a connection.
  const scope = audit.current();
  const payload = scope ? setConfigValue(scope) : undefined;

  const callback = async (tx: TTx): Promise<TResult> => {
    if (payload !== undefined) {
      await tx.$executeRaw`SELECT set_config('auditstream.actor', ${payload}, true)`;
    }
    return await fn(tx);
  };

  if (options !== undefined) {
    return await prisma.$transaction(callback, options);
  }
  return await prisma.$transaction(callback);
}
