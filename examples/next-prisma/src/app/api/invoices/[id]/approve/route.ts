import { withAudit } from "@auditstream/node/next";
import { auditTransaction } from "@auditstream/prisma";
import { NextResponse } from "next/server";
import { resolveAuditContext, resolveDemoActor } from "../../../../../lib/actor";
import { getPrisma } from "../../../../../lib/prisma";

export const dynamic = "force-dynamic";

interface ApproveInvoiceBody {
  readonly status?: string;
}

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>;
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Approves an invoice inside `auditTransaction()`, which sets transaction-local
 * `auditstream.actor` via `set_config(..., true)` instead of relying on SQL comments.
 *
 * Use `auditTransaction()` as a fallback whenever SQL comments cannot reach PostgreSQL
 * (for example under Prisma Accelerate, proxies that strip comments, or custom raw SQL
 * paths that bypass Prisma's SQL comments plugin). Because `set_config` takes precedence
 * over SQL comments per `spec/transport.md`, rows written here record `actor_source = 'set_config'`.
 */
export const POST = withAudit(
  async (request: Request, context: RouteContext) => {
    const { id: rawId } = await context.params;
    const id = parsePositiveInt(rawId);
    if (id === null) {
      return NextResponse.json({ error: "Invalid invoice id" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as ApproveInvoiceBody;
    const status =
      typeof body.status === "string" && body.status.length > 0 ? body.status : "approved";

    const prisma = getPrisma();
    const updated = await auditTransaction(prisma, (tx) =>
      tx.invoice.update({
        where: { id },
        data: { status },
      }),
    );

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      total: updated.total.toString(),
    });
  },
  {
    actor: (request) => resolveDemoActor(request.headers),
    context: (request) => resolveAuditContext(request.headers, "examples/next-prisma:set-config"),
  },
);
