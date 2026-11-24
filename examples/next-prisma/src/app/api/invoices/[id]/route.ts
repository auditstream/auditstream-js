import { withAudit } from "@auditstream/node/next";
import { NextResponse } from "next/server";
import { resolveAuditContext, resolveDemoActor } from "../../../../lib/actor";
import { getPrisma } from "../../../../lib/prisma";

export const dynamic = "force-dynamic";

interface UpdateInvoiceBody {
  readonly status?: string;
  readonly total?: string;
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

export const PATCH = withAudit(
  async (request: Request, context: RouteContext) => {
    const { id: rawId } = await context.params;
    const id = parsePositiveInt(rawId);
    if (id === null) {
      return NextResponse.json({ error: "Invalid invoice id" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as UpdateInvoiceBody;
    const data: { status?: string; total?: string } = {};
    if (typeof body.status === "string" && body.status.length > 0) {
      data.status = body.status;
    }
    if (typeof body.total === "string" && body.total.length > 0) {
      data.total = body.total;
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Provide at least one field to update" }, { status: 400 });
    }

    const prisma = getPrisma();
    const updated = await prisma.invoice.update({
      where: { id },
      data,
    });

    return NextResponse.json({
      id: updated.id,
      status: updated.status,
      total: updated.total.toString(),
    });
  },
  {
    actor: (request) => resolveDemoActor(request.headers),
    context: (request) => resolveAuditContext(request.headers, "examples/next-prisma:route"),
  },
);
