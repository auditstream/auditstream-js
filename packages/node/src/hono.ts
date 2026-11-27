import type { Context, Env, MiddlewareHandler } from "hono";
import { type Actor, type AuditContext, audit } from "./context.js";

export type { Actor, ActorType, AuditContext, NestedActor } from "./context.js";

/**
 * Options for the Hono {@link auditstream} middleware.
 *
 * Auditstream never parses sessions, cookies, or JWTs on its own; pass an `actor`
 * resolver that maps the Hono `Context` to an {@link Actor} or `undefined`.
 *
 * Pass a Hono `Env` type argument (`auditstream<AppEnv>({ ... })`), annotate
 * `(c: Context<AppEnv>)`, or wrap with `createFactory<AppEnv>().createMiddleware(...)`
 * to preserve typed `c.get(...)`, `c.var`, and `c.env` bindings inside `actor` and `context`.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches Hono's Context<E = any> and MiddlewareHandler<E = any> defaults for backwards-compatible untyped apps.
export interface HonoAuditOptions<E extends Env = any> {
  /**
   * Resolves the actor for the incoming Hono request.
   *
   * Return `undefined` to run downstream middleware and route handlers with no active scope.
   */
  readonly actor: (c: Context<E>) => Actor | undefined | PromiseLike<Actor | undefined>;

  /**
   * Optional execution context resolver for the request (for example `requestId` or `source`).
   * Only called when `actor` resolves to an {@link Actor}.
   */
  readonly context?: (
    c: Context<E>,
  ) => AuditContext | undefined | PromiseLike<AuditContext | undefined>;
}

/**
 * Creates Hono middleware that opens one `audit.as()` actor scope per request and
 * awaits `next()` inside the scope so the actor remains active until downstream handlers settle.
 *
 * Pass a Hono `Env` type argument (`auditstream<AppEnv>({ ... })`) or wrap with
 * `createFactory<AppEnv>().createMiddleware(...)` for typed `Variables` and `Bindings`.
 *
 * **Cloudflare Workers:** requires the `nodejs_als` compatibility flag, or a compatibility
 * date of `2026-08-04` or later. `@auditstream/node` uses `AsyncLocalStorage.run()` only
 * (never `enterWith()`), so it runs cleanly on Node.js, Bun, Deno, and Cloudflare Workers.
 */
// biome-ignore lint/suspicious/noExplicitAny: matches Hono's Context<E = any> and MiddlewareHandler<E = any> defaults for backwards-compatible untyped apps.
export function auditstream<E extends Env = any>(
  options: HonoAuditOptions<E>,
): MiddlewareHandler<E> {
  return async (c, next) => {
    const actor = await options.actor(c);
    if (actor === undefined) {
      await next();
      return;
    }

    const context = options.context ? await options.context(c) : undefined;
    await audit.as(
      actor,
      async () => {
        await next();
      },
      context === undefined ? undefined : { context },
    );
  };
}
