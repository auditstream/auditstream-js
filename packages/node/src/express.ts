import type { NextFunction, Request, RequestHandler, Response } from "express";
import { type Actor, type AuditContext, audit } from "./context.js";

export type { Actor, ActorType, AuditContext, NestedActor } from "./context.js";

/**
 * Options for the Express {@link auditstream} middleware.
 *
 * Auditstream never parses sessions, cookies, or JWTs on its own; pass an `actor`
 * resolver that maps the incoming Express request to an {@link Actor} or `undefined`.
 *
 * Pass a custom request subtype (`auditstream<AuthedRequest>({ ... })`) or annotate
 * `(req: AuthedRequest) => ...` to keep custom properties populated by upstream auth
 * middleware strongly typed without inline type assertions.
 */
export interface ExpressAuditOptions<TRequest extends Request = Request> {
  /**
   * Resolves the actor for the incoming request.
   *
   * Return `undefined` to run downstream handlers with no active Auditstream scope.
   * Any thrown error or rejected promise is forwarded to Express via `next(err)` and
   * prevents downstream route handlers from running.
   */
  readonly actor: (req: TRequest) => Actor | undefined | PromiseLike<Actor | undefined>;

  /**
   * Optional execution context resolver for the request (for example `requestId` or `source`).
   * Only called when `actor` resolves to an {@link Actor}.
   */
  readonly context?: (
    req: TRequest,
  ) => AuditContext | undefined | PromiseLike<AuditContext | undefined>;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Creates Express middleware that opens one `audit.as()` actor scope per request.
 *
 * Pass a request subtype (`auditstream<AuthedRequest>({ ... })`) or annotate
 * `(req: AuthedRequest)` to access properties set by upstream auth middleware without
 * inline casts. Keep optional auth fields typed as optional (`user?: ...`) so unauthenticated
 * or misordered routes stay guarded at runtime.
 *
 * Uses `AsyncLocalStorage.run()` exclusively via `@auditstream/node` (no `enterWith()`).
 * Resolver errors and invalid actor payloads (`AuditstreamError`) are forwarded to
 * Express's error handler via `next(err)` without invoking downstream route handlers.
 */
export function auditstream<TRequest extends Request = Request>(
  options: ExpressAuditOptions<TRequest>,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const typedReq = req as TRequest;
    const enterScope = (actor: Actor | undefined, context: AuditContext | undefined): void => {
      if (actor === undefined) {
        next();
        return;
      }
      void audit
        .as(
          actor,
          () => {
            next();
          },
          context === undefined ? undefined : { context },
        )
        .catch(next);
    };

    try {
      const actorOrPromise = options.actor(typedReq);
      if (isPromiseLike(actorOrPromise)) {
        void Promise.resolve(actorOrPromise)
          .then(async (actor) => {
            if (actor === undefined) {
              next();
              return;
            }
            const context = options.context ? await options.context(typedReq) : undefined;
            await audit.as(
              actor,
              () => {
                next();
              },
              context === undefined ? undefined : { context },
            );
          })
          .catch(next);
        return;
      }

      if (actorOrPromise === undefined) {
        next();
        return;
      }

      const contextOrPromise = options.context?.(typedReq);
      if (contextOrPromise !== undefined && isPromiseLike(contextOrPromise)) {
        void Promise.resolve(contextOrPromise)
          .then((context) =>
            audit.as(
              actorOrPromise,
              () => {
                next();
              },
              context === undefined ? undefined : { context },
            ),
          )
          .catch(next);
        return;
      }

      enterScope(actorOrPromise, contextOrPromise);
    } catch (error: unknown) {
      next(error);
    }
  };
}
