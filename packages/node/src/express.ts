import type { NextFunction, Request, RequestHandler, Response } from "express";
import { type Actor, type AuditContext, audit } from "./context.js";

export type { Actor, ActorType, AuditContext, NestedActor } from "./context.js";

/**
 * Options for the Express {@link auditstream} middleware.
 *
 * Auditstream never parses sessions, cookies, or JWTs on its own; pass an `actor`
 * resolver that maps the incoming Express request (and optionally `res.locals`) to an
 * {@link Actor} or `undefined`.
 *
 * Pass custom request/locals subtypes (`auditstream<AuthedRequest>({ ... })` or
 * `auditstream<Request, AuthLocals>({ ... })`) or annotate `(req: AuthedRequest, res: Response<unknown, AuthLocals>)`
 * to keep properties populated by upstream auth middleware strongly typed without inline casts.
 */
export interface ExpressAuditOptions<
  TRequest extends Request = Request,
  // biome-ignore lint/suspicious/noExplicitAny: matches @types/express Response<ResBody, Locals> constraint so TS interfaces satisfy TLocals.
  TLocals extends Record<string, any> = Record<string, unknown>,
> {
  /**
   * Resolves the actor for the incoming request.
   *
   * Return `undefined` to run downstream handlers with no active Auditstream scope.
   * If the resolver already ends or sends `res` (`res.headersSent || res.writableEnded`),
   * downstream handlers are skipped. Any thrown error or rejected promise is forwarded to
   * Express via `next(err)` and prevents downstream route handlers from running.
   */
  readonly actor: (
    req: TRequest,
    res: Response<unknown, TLocals>,
  ) => Actor | undefined | PromiseLike<Actor | undefined>;

  /**
   * Optional execution context resolver for the request (for example `requestId` or `source`).
   * Only called when `actor` resolves to an {@link Actor}.
   */
  readonly context?: (
    req: TRequest,
    res: Response<unknown, TLocals>,
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

function isResponseFinished(res: Response): boolean {
  return res.headersSent || res.writableEnded;
}

/**
 * Creates Express middleware that opens one `audit.as()` actor scope per request.
 *
 * Pass request/locals subtypes (`auditstream<AuthedRequest>({ ... })` or
 * `auditstream<Request, AuthLocals>({ ... })`) or annotate `(req, res)` to access
 * properties set by upstream auth middleware without inline casts. Keep optional auth
 * fields typed as optional (`user?: ...`) so unauthenticated or misordered routes stay
 * guarded at runtime.
 *
 * Uses `AsyncLocalStorage.run()` exclusively via `@auditstream/node` (no `enterWith()`).
 * If a resolver already sent or ended `res`, `next()` is not invoked. Resolver errors and
 * invalid actor payloads (`AuditstreamError`) are forwarded to Express's error handler via
 * `next(err)` without invoking downstream route handlers.
 */
export function auditstream<
  TRequest extends Request = Request,
  // biome-ignore lint/suspicious/noExplicitAny: matches @types/express Response<ResBody, Locals> constraint so TS interfaces satisfy TLocals.
  TLocals extends Record<string, any> = Record<string, unknown>,
>(options: ExpressAuditOptions<TRequest, TLocals>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const typedReq = req as TRequest;
    const typedRes = res as Response<unknown, TLocals>;
    const forwardError = (error: unknown): void => {
      if (!isResponseFinished(res)) {
        next(error);
      }
    };
    const enterScope = (actor: Actor | undefined, context: AuditContext | undefined): void => {
      if (isResponseFinished(res)) {
        return;
      }
      if (actor === undefined) {
        next();
        return;
      }
      void audit
        .as(
          actor,
          () => {
            if (!isResponseFinished(res)) {
              next();
            }
          },
          context === undefined ? undefined : { context },
        )
        .catch(forwardError);
    };

    try {
      const actorOrPromise = options.actor(typedReq, typedRes);
      if (isPromiseLike(actorOrPromise)) {
        void Promise.resolve(actorOrPromise)
          .then(async (actor) => {
            if (isResponseFinished(res)) {
              return;
            }
            if (actor === undefined) {
              next();
              return;
            }
            const context = options.context ? await options.context(typedReq, typedRes) : undefined;
            if (isResponseFinished(res)) {
              return;
            }
            await audit.as(
              actor,
              () => {
                if (!isResponseFinished(res)) {
                  next();
                }
              },
              context === undefined ? undefined : { context },
            );
          })
          .catch(forwardError);
        return;
      }

      if (isResponseFinished(res)) {
        return;
      }

      if (actorOrPromise === undefined) {
        next();
        return;
      }

      const contextOrPromise = options.context?.(typedReq, typedRes);
      if (contextOrPromise !== undefined && isPromiseLike(contextOrPromise)) {
        void Promise.resolve(contextOrPromise)
          .then((context) => {
            if (isResponseFinished(res)) {
              return;
            }
            return audit.as(
              actorOrPromise,
              () => {
                if (!isResponseFinished(res)) {
                  next();
                }
              },
              context === undefined ? undefined : { context },
            );
          })
          .catch(forwardError);
        return;
      }

      enterScope(actorOrPromise, contextOrPromise);
    } catch (error: unknown) {
      forwardError(error);
    }
  };
}
