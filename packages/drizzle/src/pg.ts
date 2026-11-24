import { type AuditScope, audit, isTagged, tagSql } from "@auditstream/node";

/** Subpath identifier exported by `@auditstream/drizzle/pg`. */
export const SUBPATH: "@auditstream/drizzle/pg" = "@auditstream/drizzle/pg";

/**
 * Minimal query configuration object shape accepted by `pg` and `@neondatabase/serverless` pools.
 */
export interface PgQueryConfig {
  /** SQL query text. */
  text: string;
  /** Optional bound parameter values. */
  values?: unknown[] | undefined;
  /** Optional prepared statement name (removed whenever an Auditstream tag is added). */
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

function isQueryConfig(value: unknown): value is PgQueryConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function buildTaggedConfig(config: PgQueryConfig, scope: AuditScope | undefined): PgQueryConfig {
  if (scope === undefined || isTagged(config.text)) {
    return { ...config };
  }
  const tagged: PgQueryConfig = { ...config, text: tagSql(config.text, scope) };
  // Dropping `name` prevents node-postgres / Neon from caching a distinct server-side
  // named prepared statement per actor comment.
  delete tagged.name;
  return tagged;
}

function rewriteQueryArgs(
  args: unknown[],
  scope: AuditScope | undefined,
  markPoolDecision: boolean,
): unknown[] {
  if (args.length === 0) {
    return args;
  }

  const [first, second, ...rest] = args;

  // Submittables (pg-cursor, pg-query-stream, etc.) and invalid function first-args pass through untouched.
  if (isSubmittable(first) || typeof first === "function") {
    return args;
  }

  if (typeof first === "string") {
    const nextText = scope !== undefined ? tagSql(first, scope) : first;
    if (!markPoolDecision) {
      return [nextText, ...args.slice(1)];
    }

    // Wrap string pool.query() calls in a marked config object so the pool-entry actor
    // decision (including "no actor") is final even if pg-pool queues the query and later
    // dispatches client.query() inside another request's AsyncLocalStorage context.
    if (typeof second === "function") {
      const marked: PgQueryConfig = { text: nextText };
      decidedPoolConfigs.add(marked);
      return [marked, second, ...rest];
    }
    if (second !== undefined) {
      const marked: PgQueryConfig = { text: nextText, values: second as unknown[] };
      decidedPoolConfigs.add(marked);
      return [marked, ...rest];
    }
    const marked: PgQueryConfig = { text: nextText };
    decidedPoolConfigs.add(marked);
    return [marked];
  }

  if (isQueryConfig(first)) {
    const nextConfig = buildTaggedConfig(first, scope);
    if (markPoolDecision) {
      decidedPoolConfigs.add(nextConfig);
    }
    return [nextConfig, ...args.slice(1)];
  }

  return args;
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
    // Respect decisions already finalized at pool.query() entry (tagged OR explicitly untagged).
    if (typeof first === "object" && first !== null && decidedPoolConfigs.has(first)) {
      return originalQuery.apply(this, args);
    }

    const nextArgs = rewriteQueryArgs(args, audit.current(), false);
    return originalQuery.apply(this, nextArgs);
  };
}

/**
 * Wraps a `node-postgres` (`pg.Pool`) or Neon WebSocket (`@neondatabase/serverless` `Pool`)
 * instance so every SQL statement carries the caller's active `audit.as()` actor as a trailing
 * sqlcommenter tag per Auditstream Specification 0.1.0.
 *
 * Key guarantees:
 * - **Idempotent:** returns the same `pool` instance; calling `wrapPgPool()` twice is a no-op.
 * - **Concurrency-safe under pool queuing:** reads `audit.current()` synchronously at
 *   `pool.query()` entry and marks the resulting config so queued callbacks resumed inside
 *   another request's async context never overwrite or add an actor (including actor-less calls).
 * - **Interactive transactions:** patches checked-out clients (`pool.on("connect")` and
 *   `pool.connect()`) so statements inside `db.transaction()` and savepoints read `audit.current()`
 *   from the caller's own async flow.
 * - **No named prepared statement leaks:** whenever a tag is added to a query config, its `name`
 *   property is omitted on a shallow copy so PostgreSQL never caches per-actor prepared statements.
 * - **At most one tag:** statements already tagged (for example by Drizzle 1.x `.comment()`) are
 *   left unchanged.
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
  };

  const originalPoolQuery = mutablePool.query.bind(pool);
  mutablePool.query = function patchedPoolQuery(...args: unknown[]): unknown {
    const nextArgs = rewriteQueryArgs(args, audit.current(), true);
    return originalPoolQuery(...nextArgs);
  };

  mutablePool.on("connect", (client: unknown) => {
    patchClient(client);
  });

  if (typeof mutablePool.connect === "function") {
    const originalConnect = mutablePool.connect.bind(pool);
    mutablePool.connect = function patchedPoolConnect(...args: unknown[]): unknown {
      const last = args.at(-1);
      if (typeof last === "function") {
        const userCallback = last as (err: unknown, client: unknown, done: unknown) => void;
        const wrappedCallback = (err: unknown, client: unknown, done: unknown): void => {
          if (!err && client) {
            patchClient(client);
          }
          userCallback(err, client, done);
        };
        return originalConnect(...args.slice(0, -1), wrappedCallback);
      }
      const result = originalConnect(...args);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        return (result as Promise<unknown>).then((client) => {
          patchClient(client);
          return client;
        });
      }
      return result;
    };
  }

  return pool;
}
