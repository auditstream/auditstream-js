import { audit } from "./context.js";
import { isTagged, tagSql } from "./transport.js";

/** Subpath identifier exported by `@auditstream/node/neon-http`. */
export const SUBPATH: "@auditstream/node/neon-http" = "@auditstream/node/neon-http";

/**
 * Minimal interface compatible with a Neon HTTP SQL client (`neon(...)` from
 * `@neondatabase/serverless`).
 */
export interface NeonHttpClientLike {
  /** Callable entry point (string SQL query or tagged-template literal). */
  (...args: never[]): unknown;
  /** Builds a lazy parameterized HTTP SQL query. */
  query: (...args: never[]) => unknown;
  /** Executes an array of lazy queries inside a single non-interactive HTTP transaction. */
  transaction?: (...args: never[]) => unknown;
}

const wrappedClients = new WeakSet<object>();

function tagQueryText(text: string): string {
  const scope = audit.current();
  if (scope === undefined || isTagged(text)) {
    return text;
  }
  return tagSql(text, scope);
}

/**
 * Wraps a Neon HTTP client (`neon(...)` from `@neondatabase/serverless`) so every SQL query
 * constructed via `sql.query()` or a plain string call `sql(text, params?, opts?)` carries the
 * active `audit.as()` actor as a trailing sqlcommenter tag per Auditstream Specification 0.1.0.
 *
 * Works with plain Neon HTTP, Drizzle, or any query builder executing through `sql.query()`
 * without requiring any ORM peer dependency.
 *
 * Key guarantees:
 * - **Idempotent:** calling `wrapNeonHttp()` on an already-wrapped client returns it unchanged.
 * - **Batches and HTTP transactions:** Neon HTTP queries are lazy and execute when awaited or
 *   passed to `sql.transaction([...])` / Drizzle `db.batch([...])`. The actor is read
 *   synchronously when `query()` is called, so every query in a batch or HTTP transaction
 *   retains the actor active where that query was built.
 * - **At most one tag:** queries already tagged (for example by Drizzle 1.x `.comment()` or
 *   `tagSql()`) are passed through unchanged.
 * - **Tagged-template calls untouched:** template-literal invocations pass through untouched
 *   without tagging because the SQL text is constructed inside `@neondatabase/serverless`.
 */
export function wrapNeonHttp<TClient extends NeonHttpClientLike>(sql: TClient): TClient {
  if (wrappedClients.has(sql)) {
    return sql;
  }

  const rawQuery = sql.query as (text: string, params?: unknown[], opts?: unknown) => unknown;

  const wrappedQuery = (text: string, params?: unknown[], opts?: unknown): unknown => {
    const nextText = tagQueryText(text);
    if (opts !== undefined) {
      return rawQuery.call(sql, nextText, params, opts);
    }
    if (params !== undefined) {
      return rawQuery.call(sql, nextText, params);
    }
    return rawQuery.call(sql, nextText);
  };

  const proxy = new Proxy(sql, {
    apply(target, thisArg, args: unknown[]) {
      if (typeof args[0] === "string") {
        return wrappedQuery(args[0], args[1] as unknown[] | undefined, args[2]);
      }
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop === "query") {
        return wrappedQuery;
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  wrappedClients.add(proxy);
  return proxy;
}
