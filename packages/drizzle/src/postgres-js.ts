import { audit, isTagged, tagSql } from "@auditstream/node";

/** Subpath identifier exported by `@auditstream/drizzle/postgres-js`. */
export const SUBPATH: "@auditstream/drizzle/postgres-js" = "@auditstream/drizzle/postgres-js";

/**
 * Minimal options shape accepted by `postgres.js`'s `unsafe()` method.
 */
export interface PostgresJsUnsafeOptions {
  /** Whether `postgres.js` should prepare a named server-side statement for this query. */
  prepare?: boolean | undefined;
  /** Additional driver-specific options passed through unchanged. */
  [key: string]: unknown;
}

/**
 * Minimal interface compatible with a `postgres.js` transaction or savepoint client
 * (`postgres.TransactionSql`).
 */
export interface PostgresJsTransactionLike {
  /** Executes a raw parameterized SQL query string (used by Drizzle for every statement). */
  unsafe: (...args: never[]) => unknown;
  /** Starts a nested savepoint inside the transaction. */
  savepoint?: (...args: never[]) => unknown;
}

/**
 * Minimal interface compatible with a root `postgres.js` client (`postgres.Sql`).
 */
export interface PostgresJsLike extends PostgresJsTransactionLike {
  /** Starts an interactive database transaction. */
  begin: (...args: never[]) => unknown;
}

const wrappedClients = new WeakSet<object>();

function createUnsafeWrapper(
  target: PostgresJsTransactionLike,
): (
  query: string,
  parameters?: readonly unknown[],
  queryOptions?: PostgresJsUnsafeOptions,
) => unknown {
  const rawUnsafe = target.unsafe as (
    query: string,
    parameters?: readonly unknown[],
    queryOptions?: PostgresJsUnsafeOptions,
  ) => unknown;

  return function wrappedUnsafe(
    query: string,
    parameters?: readonly unknown[],
    queryOptions?: PostgresJsUnsafeOptions,
  ): unknown {
    const scope = audit.current();
    if (scope === undefined || isTagged(query)) {
      if (queryOptions !== undefined) {
        return rawUnsafe.call(target, query, parameters, queryOptions);
      }
      if (parameters !== undefined) {
        return rawUnsafe.call(target, query, parameters);
      }
      return rawUnsafe.call(target, query);
    }

    const taggedQuery = tagSql(query, scope);
    // Always disable named server-side prepared statements when adding a per-actor comment
    // so PostgreSQL and poolers never accumulate one prepared statement per actor.
    const nextOptions: PostgresJsUnsafeOptions = { ...queryOptions, prepare: false };
    return rawUnsafe.call(target, taggedQuery, parameters, nextOptions);
  };
}

function wrapTransactionCallback<TArgs extends unknown[]>(args: TArgs): TArgs {
  // Both sql.begin(cb) / sql.begin(options, cb) and tx.savepoint(cb) / tx.savepoint(name, cb)
  // pass the callback as the last argument.
  const lastIndex = args.length - 1;
  if (lastIndex < 0) {
    return args;
  }
  const last = args[lastIndex];
  if (typeof last !== "function") {
    return args;
  }
  const userCallback = last as (tx: PostgresJsTransactionLike) => unknown;
  const wrappedArgs = [...args] as TArgs;
  wrappedArgs[lastIndex] = (tx: PostgresJsTransactionLike): unknown =>
    userCallback(wrapTransactionClient(tx));
  return wrappedArgs;
}

function wrapTransactionClient<TTx extends PostgresJsTransactionLike>(tx: TTx): TTx {
  if (typeof tx !== "object" && typeof tx !== "function") {
    return tx;
  }
  if (tx === null || wrappedClients.has(tx)) {
    return tx;
  }

  const unsafeWrapper = createUnsafeWrapper(tx);

  const proxy = new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        return unsafeWrapper;
      }
      if (prop === "savepoint" && typeof target.savepoint === "function") {
        const origSavepoint = target.savepoint as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown =>
          origSavepoint.apply(target, wrapTransactionCallback(args));
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  wrappedClients.add(proxy);
  return proxy;
}

/**
 * Wraps a `postgres.js` (`postgres(...)`) client so every `unsafe()` statement issued by Drizzle
 * carries the active `audit.as()` actor as a trailing sqlcommenter tag per Auditstream
 * Specification 0.1.0.
 *
 * Key guarantees:
 * - **Idempotent:** calling `wrapPostgresJs()` on an already-wrapped client returns it unchanged.
 * - **Transactions and nested savepoints:** intercepts `begin()` and recursive `savepoint()`
 *   callbacks so every `unsafe()` call inside interactive transactions is tagged with the active
 *   caller's actor.
 * - **No named prepared statement leaks:** whenever a tag is added, forces `prepare: false` on a
 *   shallow copy of `queryOptions` while preserving all other options. Calls outside a scope or
 *   already tagged (for example by Drizzle 1.x `.comment()`) keep the caller's original options
 *   untouched.
 * - **Tagged-template calls untouched:** template-literal invocations (for example `sql` tagged
 *   templates) build their SQL text inside `postgres.js` and are passed through untouched without
 *   tagging. Drizzle sends all queries through `unsafe()`, never tagged templates.
 */
export function wrapPostgresJs<TSql extends PostgresJsLike>(sql: TSql): TSql {
  if (wrappedClients.has(sql)) {
    return sql;
  }

  const unsafeWrapper = createUnsafeWrapper(sql);

  const proxy = new Proxy(sql, {
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        return unsafeWrapper;
      }
      if (prop === "begin" && typeof target.begin === "function") {
        const origBegin = target.begin as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown =>
          origBegin.apply(target, wrapTransactionCallback(args));
      }
      if (prop === "savepoint" && typeof target.savepoint === "function") {
        const origSavepoint = target.savepoint as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown =>
          origSavepoint.apply(target, wrapTransactionCallback(args));
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  wrappedClients.add(proxy);
  return proxy;
}
