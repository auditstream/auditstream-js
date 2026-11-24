import type { Context, MiddlewareHandler } from "hono";
import { type Actor, type AuditContext, audit } from "./context.js";

export type { Actor, ActorType, AuditContext, NestedActor } from "./context.js";

/**
 * Options for the Hono {@link auditstream} middleware.
 *
 * Auditstream never parses sessions, cookies, or JWTs on its own; pass an `actor`
 * resolver that maps the Hono `Context` to an {@link Actor} or `undefined`.
 */
export interface HonoAuditOptions {
  /**
   * Resolves the actor for the incoming Hono request.
   *
   * Return `undefined` to run downstream middleware and route handlers with no active scope.
   */
  readonly actor: (c: Context) => Actor | undefined | PromiseLike<Actor | undefined>;

  /**
   * Optional execution context resolver for the request (for example `requestId` or `source`).
   * Only called when `actor` resolves to an {@link Actor}.
   */
  readonly context?: (
    c: Context,
  ) => AuditContext | undefined | PromiseLike<AuditContext | undefined>;
}

/**
 * Creates Hono middleware that opens one `audit.as()` actor scope per request and
 * awaits `next()` inside the scope so the actor remains active until downstream handlers settle.
 *
 * **Cloudflare Workers:** requires the `nodejs_als` compatibility flag, or a compatibility
 * date of `2026-08-04` or later. `@auditstream/node` uses `AsyncLocalStorage.run()` only
 * (never `enterWith()`), so it runs cleanly on Node.js, Bun, Deno, and Cloudflare Workers.
 */
export function auditstream(options: HonoAuditOptions): MiddlewareHandler {
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
