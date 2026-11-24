import { withAudit } from "@auditstream/node/next";
import { NextResponse } from "next/server";
import { resolveAuditContext, resolveDemoActor } from "../../../lib/actor";
import { getPrisma } from "../../../lib/prisma";

export const dynamic = "force-dynamic";

interface CreateInvoiceBody {
  readonly status?: string;
  readonly total?: string;
}

export const POST = withAudit(
  async (request: Request) => {
    const body = (await request.json().catch(() => ({}))) as CreateInvoiceBody;
    const status =
      typeof body.status === "string" && body.status.length > 0 ? body.status : "draft";
    const total = typeof body.total === "string" && body.total.length > 0 ? body.total : "0.00";

    const prisma = getPrisma();
    const created = await prisma.invoice.create({
      data: { status, total },
    });

    return NextResponse.json(
      { id: created.id, status: created.status, total: created.total.toString() },
      { status: 201 },
    );
  },
  {
    actor: (request) => resolveDemoActor(request.headers),
    context: (request) => resolveAuditContext(request.headers, "examples/next-prisma:route"),
  },
);
