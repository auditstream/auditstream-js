import { AsyncLocalStorage } from "node:async_hooks";
import { type AuditScope, audit } from "./context.js";
import { isTagged, tagSql } from "./transport.js";

/** Subpath identifier exported by `@auditstream/node/pg`. */
export const SUBPATH: "@auditstream/node/pg" = "@auditstream/node/pg";

/**
 * Minimal query configuration object shape accepted by `pg` and `@neondatabase/serverless` pools.
 */
export interface PgQueryConfig {
  /** SQL query text. */
  text: string;
  /** Optional bound parameter values. */
  values?: unknown[] | undefined;
  /** Optional prepared statement name (removed whenever the query carries an Auditstream tag). */
  name?: string | undefined;
  /** Additional driver-specific fields (for example `rowMode`, `types`). */
  [key: string]: unknown;
}

/**
 * Minimal submittable query object (such as `pg-cursor` or `pg-query-stream`).
 * Submittables are passed through untouched by {@link wrapPgPool}.
 */
export interface PgSubmittable {
  /** Driver submission hook used by `pg` clients. */
  submit: (...args: unknown[]) => unknown;
}

/**
 * Minimal client interface compatible with `pg.PoolClient` and `@neondatabase/serverless` `PoolClient`.
 */
export interface PgClientLike {
  /** Executes a query on a checked-out connection. */
  query: (...args: never[]) => unknown;
}

/**
 * Minimal pool interface compatible with `pg.Pool` and `@neondatabase/serverless` `Pool`.
 */
export interface PgPoolLike {
  /** Executes a single query on the pool. */
  query: (...args: never[]) => unknown;
  /** Checks out a client from the pool (promise or callback form). */
  connect?: (...args: never[]) => unknown;
  /** Registers pool lifecycle listeners (including `"connect"`). */
  on: (event: "connect", listener: (client: unknown) => void) => unknown;
}

const wrappedPools = new WeakSet<object>();
const wrappedClients = new WeakSet<object>();
const decidedPoolConfigs = new WeakSet<object>();

function isSubmittable(value: unknown): value is PgSubmittable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { submit?: unknown }).submit === "function"
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function cloneQueryConfig(
  config: PgQueryConfig,
  nextText: string,
  dropName: boolean,
): PgQueryConfig {
  const proto: object | null = Object.getPrototypeOf(config);
  const descriptors = Object.getOwnPropertyDescriptors(config);
  if (dropName) {
    // Dropping `name` prevents node-postgres / Neon from caching a distinct server-side
    // named prepared statement per actor comment.
    delete descriptors.name;
  }
  descriptors.text = {
    value: nextText,
    enumerable: true,
    writable: true,
    configurable: true,
  };
  const copy = Object.defineProperties(Object.create(proto), descriptors) as PgQueryConfig;
  if (dropName && "name" in copy) {
    // Shadow prototype-inherited `name` so pg / Neon never caches a named prepared statement.
    Object.defineProperty(copy, "name", {
      value: undefined,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function buildTaggedConfig(
  config: PgQueryConfig,
  text: string,
  scope: AuditScope | undefined,
): PgQueryConfig {
  if (isTagged(text)) {
    return cloneQueryConfig(config, text, true);
  }
  if (scope === undefined) {
    return cloneQueryConfig(config, text, false);
  }
  return cloneQueryConfig(config, tagSql(text, scope), true);
}

function rewriteStringQueryArgs(
  args: unknown[],
  first: string,
  scope: AuditScope | undefined,
  markPoolDecision: boolean,
): unknown[] {
  const nextText = !isTagged(first) && scope !== undefined ? tagSql(first, scope) : first;
  if (!markPoolDecision) {
    return [nextText, ...args.slice(1)];
  }

  // Wrap string pool.query() calls in a marked config object so the pool-entry actor
  // decision (including "no actor") is final even if pg-pool queues the query and later
  // dispatches client.query() inside another request's AsyncLocalStorage context.
  const [, second, ...rest] = args;
  const isCallback = typeof second === "function";
  const marked: PgQueryConfig =
    !isCallback && second !== undefined
      ? { text: nextText, values: second as unknown[] }
      : { text: nextText };
  decidedPoolConfigs.add(marked);
  if (isCallback) {
    return [marked, second, ...rest];
  }
  return rest.length > 0 ? [marked, undefined, ...rest] : [marked];
}

function rewriteQueryArgs(
  args: unknown[],
  scope: AuditScope | undefined,
  markPoolDecision: boolean,
): unknown[] {
  if (args.length === 0) {
    return args;
  }

  const [first] = args;

  // Submittables (pg-cursor, pg-query-stream, etc.) and functions pass through untouched.
  if (isSubmittable(first) || typeof first === "function") {
    return args;
  }

  if (typeof first === "string") {
    return rewriteStringQueryArgs(args, first, scope, markPoolDecision);
  }

  if (typeof first === "object" && first !== null) {
    const rawText: unknown = (first as { text?: unknown }).text;
    if (typeof rawText === "string") {
      const nextConfig = buildTaggedConfig(first as PgQueryConfig, rawText, scope);
      if (markPoolDecision) {
        decidedPoolConfigs.add(nextConfig);
      }
      return [nextConfig, ...args.slice(1)];
    }
  }

  return args;
}

function findConnectCallbackIndex(args: readonly unknown[]): number {
  if (typeof args[0] === "function") {
    return 0;
  }
  if (args.length > 1 && typeof args.at(-1) === "function") {
    return args.length - 1;
  }
  return -1;
}

function patchClient(client: unknown): void {
  if (typeof client !== "object" || client === null || wrappedClients.has(client)) {
    return;
  }
  const target = client as { query?: (...args: unknown[]) => unknown };
  if (typeof target.query !== "function") {
    return;
  }
  wrappedClients.add(target);

  const originalQuery = target.query;
  target.query = function patchedClientQuery(this: unknown, ...args: unknown[]): unknown {
    const first = args[0];
    // Respect one-shot decisions already finalized at pool.query() entry (tagged OR untagged),
    // consuming the entry so reusing a config on client.query() later cannot bypass tagging.
    if (typeof first === "object" && first !== null && decidedPoolConfigs.delete(first)) {
      return originalQuery.apply(this, args);
    }

    const nextArgs = rewriteQueryArgs(args, audit.current(), false);
    return originalQuery.apply(this, nextArgs);
  };
}

function wrapPoolConnectCallback(
  userCallback: (err: unknown, client: unknown, done: unknown) => void,
): (err: unknown, client: unknown, done: unknown) => void {
  // Capture the caller's AsyncLocalStorage context at pool.connect(cb) entry so queued
  // callbacks resumed inside another request's client.release() never inherit that actor.
  const runInCallerContext = AsyncLocalStorage.snapshot();
  return (err: unknown, client: unknown, done: unknown): void => {
    if (!err && client) {
      patchClient(client);
    }
    runInCallerContext(userCallback, err, client, done);
  };
}

function wrapConnectResult(result: unknown): unknown {
  if (!isThenable(result)) {
    patchClient(result);
    return result;
  }
  return Promise.resolve(result).then((client) => {
    patchClient(client);
    return client;
  });
}

/**
 * Wraps a `node-postgres` (`pg.Pool`) or Neon WebSocket (`@neondatabase/serverless` `Pool`)
 * instance so every SQL statement carries the caller's active `audit.as()` actor as a trailing
 * sqlcommenter tag per Auditstream Specification 0.1.0.
 *
 * Works with plain `pg`, Kysely, TypeORM, Knex, Drizzle, or any other library backed by a
 * `pg.Pool`-compatible client without requiring any ORM peer dependency.
 *
 * Key guarantees:
 * - **Idempotent:** returns the same `pool` instance; calling `wrapPgPool()` twice is a no-op.
 * - **Concurrency-safe under pool queuing:** reads `audit.current()` synchronously at
 *   `pool.query()` entry and marks the resulting config so queued callbacks resumed inside
 *   another request's async context never overwrite or add an actor (including actor-less calls);
 *   callback-style `pool.connect(cb)` snapshots and restores the caller's `AsyncLocalStorage`
 *   context when the queued callback fires.
 * - **Interactive transactions:** patches checked-out clients (`pool.prependListener("connect")`
 *   with `pool.on("connect")` fallback, plus `pool.connect()`) so statements inside
 *   transactions and savepoints read `audit.current()` from the caller's own async flow.
 * - **No named prepared statement leaks:** whenever a query config carries an Auditstream tag
 *   (added here or already tagged, for example by Drizzle 1.x `.comment()`), its `name` property
 *   is removed on a shallow copy so PostgreSQL never caches per-actor prepared statements.
 * - **At most one tag:** statements already tagged (for example by Drizzle 1.x `.comment()` or
 *   `tagSql()`) are not double-tagged.
 * - **Submittables untouched:** submittable objects with a `.submit()` method (such as `pg-cursor`
 *   or `pg-query-stream`) are passed through untouched.
 */
export function wrapPgPool<TPool extends PgPoolLike>(pool: TPool): TPool {
  if (wrappedPools.has(pool)) {
    return pool;
  }
  wrappedPools.add(pool);

  const mutablePool = pool as unknown as {
    query: (...args: unknown[]) => unknown;
    connect?: (...args: unknown[]) => unknown;
    on: (event: "connect", listener: (client: unknown) => void) => unknown;
    prependListener?: (event: "connect", listener: (client: unknown) => void) => unknown;
  };

  const originalPoolQuery = mutablePool.query.bind(pool);
  mutablePool.query = function patchedPoolQuery(...args: unknown[]): unknown {
    const nextArgs = rewriteQueryArgs(args, audit.current(), true);
    return originalPoolQuery(...nextArgs);
  };

  if (typeof mutablePool.prependListener === "function") {
    mutablePool.prependListener("connect", patchClient);
  } else {
    mutablePool.on("connect", patchClient);
  }

  if (typeof mutablePool.connect === "function") {
    const originalConnect = mutablePool.connect.bind(pool);
    mutablePool.connect = function patchedPoolConnect(...args: unknown[]): unknown {
      const cbIndex = findConnectCallbackIndex(args);
      if (cbIndex >= 0) {
        const userCallback = args[cbIndex] as (
          err: unknown,
          client: unknown,
          done: unknown,
        ) => void;
        const nextArgs = [...args];
        nextArgs[cbIndex] = wrapPoolConnectCallback(userCallback);
        return wrapConnectResult(originalConnect(...nextArgs));
      }
      return wrapConnectResult(originalConnect(...args));
    };
  }

  return pool;
}
