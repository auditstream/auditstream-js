import { AuditstreamError, type EventSourceKind } from "@auditstream/node";
import { NextResponse } from "next/server";
import { queryActivityFeed } from "../../../lib/activity";
import { resolveDemoTenant } from "../../../lib/actor";

export const dynamic = "force-dynamic";

function optionalParam(params: URLSearchParams, name: string): string | undefined {
  const raw = params.get(name)?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function parseSource(raw: string | undefined): EventSourceKind | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "db" || raw === "app") {
    return raw;
  }
  throw new AuditstreamError("INVALID_QUERY", 'source must be "db" or "app"');
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new AuditstreamError("INVALID_QUERY", "limit must be a positive integer");
  }
  return Number.parseInt(raw, 10);
}

/**
 * BFF Route Handler powering the copy-paste Activity Feed (`/activity`).
 *
 * Security notes:
 * - Enforces tenant scoping strictly from server-side auth context (`resolveDemoTenant`),
 *   intentionally ignoring any `?tenant=` query parameter sent by the browser.
 * - **Demo only:** in production, require a verified session/JWT and return `401`/`403`
 *   when unauthenticated rather than allowing unscoped reads.
 * - Returns allowlisted {@link ActivityFeedItem} DTOs only (never raw `HistoryEntry` rows).
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const params = new URL(request.url).searchParams;
    const source = parseSource(optionalParam(params, "source"));
    const opPrefix = optionalParam(params, "opPrefix");
    const since = optionalParam(params, "since");
    const until = optionalParam(params, "until");
    const cursor = optionalParam(params, "cursor");
    const limit = parseLimit(optionalParam(params, "limit"));

    // Derive tenant strictly on the server; ignore any client-supplied `?tenant=` param.
    const tenant = resolveDemoTenant(request.headers);

    const page = await queryActivityFeed({
      source,
      opPrefix,
      since,
      until,
      cursor,
      limit,
      tenant,
    });

    return NextResponse.json(page, {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof AuditstreamError && err.code === "INVALID_QUERY") {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
