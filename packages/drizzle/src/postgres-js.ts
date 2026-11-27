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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalizeUnsafeArgs(rest: readonly unknown[]): {
  readonly parameters: unknown;
  readonly rawOptions: unknown;
} {
  const second = rest[0];
  // Match postgres.js: a 2-argument call with a non-array second argument passes options.
  if (rest.length === 1 && second !== undefined && !Array.isArray(second)) {
    return { parameters: [], rawOptions: second };
  }
  return { parameters: second, rawOptions: rest[1] };
}

function buildNextOptions(queryOptions: unknown): PostgresJsUnsafeOptions {
  if (queryOptions === undefined) {
    return { prepare: false };
  }
  // Match postgres.js `'simple' in options` semantics: throws TypeError on null/primitives
  // and retains prototype-inherited `simple` while forcing `prepare: false`.
  const hasSimple = "simple" in (queryOptions as object);
  const nextOptions: PostgresJsUnsafeOptions = {
    ...(queryOptions as PostgresJsUnsafeOptions),
    prepare: false,
  };
  if (hasSimple && !Object.hasOwn(nextOptions, "simple")) {
    nextOptions.simple = (queryOptions as PostgresJsUnsafeOptions).simple;
  }
  return nextOptions;
}

function createUnsafeWrapper(
  target: PostgresJsTransactionLike,
): (query: string, ...rest: unknown[]) => unknown {
  const rawUnsafe = target.unsafe as (...args: unknown[]) => unknown;

  return function wrappedUnsafe(query: string, ...rest: unknown[]): unknown {
    if (typeof query !== "string") {
      return rawUnsafe.call(target, query, ...rest);
    }

    const alreadyTagged = isTagged(query);
    const scope = alreadyTagged ? undefined : audit.current();

    if (!alreadyTagged && scope === undefined) {
      return rawUnsafe.call(target, query, ...rest);
    }

    const { parameters, rawOptions } = normalizeUnsafeArgs(rest);
    const nextQuery = scope === undefined ? query : tagSql(query, scope);
    // Always disable named server-side prepared statements whenever a query carries an
    // Auditstream tag (added here or pre-tagged, e.g. by Drizzle 1.x `.comment()`) so
    // PostgreSQL and poolers never accumulate one prepared statement per actor.
    const nextOptions = buildNextOptions(rawOptions);
    return rawUnsafe.call(target, nextQuery, parameters, nextOptions);
  };
}

function findBeginCallbackIndex(args: readonly unknown[]): number {
  // Match postgres.js begin(options, fn): `!fn && (fn = options, options = '')`.
  if (typeof args[1] === "function") {
    return 1;
  }
  if (!args[1] && typeof args[0] === "function") {
    return 0;
  }
  return -1;
}

function findSavepointCallbackIndex(args: readonly unknown[]): number {
  // Match postgres.js savepoint(name, fn): skip template-string calls (`Array.isArray(name.raw)`),
  // wrap args[0] when 1 arg, else wrap args[1].
  const first = args[0];
  if (first && Array.isArray((first as { raw?: unknown }).raw)) {
    return -1;
  }
  if (args.length === 1) {
    return typeof first === "function" ? 0 : -1;
  }
  return typeof args[1] === "function" ? 1 : -1;
}

function wrapCallbackArgs<TArgs extends unknown[]>(args: TArgs, callbackIndex: number): TArgs {
  if (callbackIndex < 0) {
    return args;
  }
  const userCallback = args[callbackIndex] as (tx: PostgresJsTransactionLike) => unknown;
  const wrappedArgs = [...args] as TArgs;
  wrappedArgs[callbackIndex] = (tx: PostgresJsTransactionLike): unknown =>
    userCallback(wrapClient(tx));
  return wrappedArgs;
}

function wrapCallbackMethod(
  target: PostgresJsTransactionLike,
  method: (...args: unknown[]) => unknown,
  findIndex: (args: readonly unknown[]) => number,
): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown =>
    method.apply(target, wrapCallbackArgs(args, findIndex(args)));
}

function wrapReserveMethod(
  target: PostgresJsTransactionLike,
  method: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    const result = method.apply(target, args);
    if (!isThenable(result)) {
      return wrapClient(result as PostgresJsTransactionLike);
    }
    return Promise.resolve(result).then((reserved) =>
      wrapClient(reserved as PostgresJsTransactionLike),
    );
  };
}

function resolveClientProperty(
  target: PostgresJsTransactionLike,
  prop: string | symbol,
  receiver: unknown,
  unsafeWrapper: (query: string, ...rest: unknown[]) => unknown,
): unknown {
  if (prop === "unsafe") {
    return unsafeWrapper;
  }
  const value: unknown = Reflect.get(target, prop, receiver);
  if (typeof value !== "function") {
    return value;
  }
  if (prop === "begin") {
    return wrapCallbackMethod(
      target,
      value as (...args: unknown[]) => unknown,
      findBeginCallbackIndex,
    );
  }
  if (prop === "savepoint") {
    return wrapCallbackMethod(
      target,
      value as (...args: unknown[]) => unknown,
      findSavepointCallbackIndex,
    );
  }
  if (prop === "reserve") {
    return wrapReserveMethod(target, value as (...args: unknown[]) => unknown);
  }
  return value;
}

function wrapClient<TClient extends PostgresJsTransactionLike>(client: TClient): TClient {
  if ((typeof client !== "object" && typeof client !== "function") || client === null) {
    return client;
  }
  if (wrappedClients.has(client)) {
    return client;
  }

  const unsafeWrapper = createUnsafeWrapper(client);

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      return resolveClientProperty(target, prop, receiver, unsafeWrapper);
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
 * - **Transactions, savepoints, and reserved connections:** intercepts `begin()`, recursive
 *   `savepoint()` callbacks, and `reserve()` so every `unsafe()` call inside interactive
 *   transactions or on reserved connections is tagged with the active caller's actor.
 * - **No named prepared statement leaks:** forces `prepare: false` on a shallow copy of
 *   `queryOptions` (while preserving all other options, including on the 2-argument
 *   `unsafe(query, options)` overload) whenever a tag is added or the query is already tagged
 *   (for example by Drizzle 1.x `.comment()`). Only untagged calls outside a scope keep the
 *   caller's original options untouched.
 * - **Tagged-template calls untouched:** template-literal invocations (for example `sql` tagged
 *   templates) build their SQL text inside `postgres.js` and are passed through untouched without
 *   tagging. Drizzle sends all queries through `unsafe()`, never tagged templates.
 */
export function wrapPostgresJs<TSql extends PostgresJsLike>(sql: TSql): TSql {
  return wrapClient(sql);
}
