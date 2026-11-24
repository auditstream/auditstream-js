import { type Actor, type AuditContext, audit } from "./context.js";

export type { Actor, ActorType, AuditContext, NestedActor } from "./context.js";

/**
 * Options for {@link withAudit}, wrapping a Next.js Route Handler.
 *
 * **Next.js 16 `proxy` header rule:** Next.js 16 renamed `middleware` to `proxy`. Because
 * data leaves `proxy` only through headers, cookies, rewrites, redirects, or the URL,
 * `proxy` cannot hold an `AsyncLocalStorage` scope for downstream Route Handlers or Server
 * Actions. If `proxy` forwards identity in a request header, it **MUST overwrite or strip
 * that header on every incoming request**; otherwise a client can spoof an actor header.
 */
export interface NextAuditOptions<TRequest extends Request = Request> {
  /**
   * Resolves the actor for the incoming request.
   *
   * Return `undefined` to execute the Route Handler with no active Auditstream scope.
   */
  readonly actor: (request: TRequest) => Actor | undefined | PromiseLike<Actor | undefined>;

  /**
   * Optional execution context resolver for the request (for example `requestId` or `source`).
   * Only called when `actor` resolves to an {@link Actor}.
   */
  readonly context?: (
    request: TRequest,
  ) => AuditContext | undefined | PromiseLike<AuditContext | undefined>;
}

/**
 * Options for {@link auditAction}, wrapping a Next.js Server Action.
 *
 * **Next.js 16 `proxy` header rule:** `proxy` cannot propagate `AsyncLocalStorage` into
 * Server Actions. If `proxy` forwards identity in a request header, it **MUST overwrite or
 * strip that header on every incoming request** so clients cannot forge actor identity.
 */
export interface NextActionAuditOptions<TArgs extends readonly unknown[] = readonly unknown[]> {
  /**
   * Resolves the actor for the Server Action invocation.
   *
   * Return `undefined` to execute the action with no active Auditstream scope.
   */
  readonly actor: (...args: TArgs) => Actor | undefined | PromiseLike<Actor | undefined>;

  /**
   * Optional execution context resolver for the action invocation.
   * Only called when `actor` resolves to an {@link Actor}.
   */
  readonly context?: (
    ...args: TArgs
  ) => AuditContext | undefined | PromiseLike<AuditContext | undefined>;
}

/**
 * Wraps a Next.js Route Handler so each request executes inside one `audit.as()` scope.
 *
 * Does not import `next` at runtime and works with both `NextRequest` and standard Web
 * `Request` objects. Awaits the handler inside `AsyncLocalStorage.run()` so lazy thenables
 * (such as Prisma queries) retain the active actor.
 *
 * **Next.js 16 `proxy` header rule:** `proxy` cannot carry an `AsyncLocalStorage` scope into
 * Route Handlers. If `proxy` forwards identity in a request header, it MUST overwrite or
 * strip that header on every request so clients cannot spoof an actor.
 *
 * **Cloudflare Workers / edge-like runtimes:** requires the `nodejs_als` compatibility flag
 * or a compatibility date of `2026-08-04` or later (`AsyncLocalStorage.run()` only).
 */
export function withAudit<
  TRequest extends Request = Request,
  TArgs extends readonly unknown[] = [],
  TResult = Response,
>(
  handler: (request: TRequest, ...args: TArgs) => TResult | PromiseLike<TResult>,
  options: NextAuditOptions<TRequest>,
): (request: TRequest, ...args: TArgs) => Promise<Awaited<TResult>> {
  return async (request: TRequest, ...args: TArgs): Promise<Awaited<TResult>> => {
    const actor = await options.actor(request);
    if (actor === undefined) {
      return await handler(request, ...args);
    }

    const context = options.context ? await options.context(request) : undefined;
    return await audit.as(
      actor,
      () => handler(request, ...args),
      context === undefined ? undefined : { context },
    );
  };
}

/**
 * Wraps a Next.js Server Action so each invocation executes inside one `audit.as()` scope.
 *
 * Does not import `next` at runtime. Awaits the action inside `AsyncLocalStorage.run()` so
 * lazy thenables (such as Prisma queries) retain the active actor.
 *
 * **Next.js 16 `proxy` header rule:** `proxy` cannot carry an `AsyncLocalStorage` scope into
 * Server Actions. If `proxy` forwards identity in a request header, it MUST overwrite or
 * strip that header on every request so clients cannot spoof an actor.
 *
 * **Cloudflare Workers / edge-like runtimes:** requires the `nodejs_als` compatibility flag
 * or a compatibility date of `2026-08-04` or later (`AsyncLocalStorage.run()` only).
 */
export function auditAction<TArgs extends readonly unknown[], TResult>(
  action: (...args: TArgs) => TResult | PromiseLike<TResult>,
  options: NextActionAuditOptions<TArgs>,
): (...args: TArgs) => Promise<Awaited<TResult>> {
  return async (...args: TArgs): Promise<Awaited<TResult>> => {
    const actor = await options.actor(...args);
    if (actor === undefined) {
      return await action(...args);
    }

    const context = options.context ? await options.context(...args) : undefined;
    return await audit.as(
      actor,
      () => action(...args),
      context === undefined ? undefined : { context },
    );
  };
}
