import { audit } from "@auditstream/node";
import { withAudit } from "@auditstream/node/next";
import { auditTransaction } from "@auditstream/prisma";
import { NextResponse } from "next/server";
import { resolveAuditContext, resolveDemoActor } from "../../../../../lib/actor";
import { getPrisma } from "../../../../../lib/prisma";

export const dynamic = "force-dynamic";

const ALLOWED_FORMATS = new Set(["pdf", "csv"]);

interface ExportInvoiceBody {
  readonly format?: string;
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
 * Records an application-level audit event (`source = 'app'`, action `invoice.exported`)
 * through `audit.log()` inside `auditTransaction()` without modifying the `invoice` table.
 */
export const POST = withAudit(
  async (request: Request, context: RouteContext) => {
    const { id: rawId } = await context.params;
    const id = parsePositiveInt(rawId);
    if (id === null) {
      return NextResponse.json({ error: "Invalid invoice id" }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as ExportInvoiceBody;
    const format =
      typeof body.format === "string" && body.format.trim().length > 0
        ? body.format.trim().toLowerCase()
        : "pdf";
    if (!ALLOWED_FORMATS.has(format)) {
      return NextResponse.json({ error: 'format must be "pdf" or "csv"' }, { status: 400 });
    }

    const prisma = getPrisma();
    const invoice = await prisma.invoice.findUnique({ where: { id } });
    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    await auditTransaction(prisma, (tx) =>
      audit.log((sql, values) => tx.$queryRawUnsafe(sql, ...values), {
        action: "invoice.exported",
        target: { id: invoice.id },
        data: { format, status: invoice.status },
      }),
    );

    return NextResponse.json(
      {
        exported: true,
        invoiceId: invoice.id,
        format,
        action: "invoice.exported",
      },
      { status: 201 },
    );
  },
  {
    actor: (request) => resolveDemoActor(request.headers),
    context: (request) => resolveAuditContext(request.headers, "examples/next-prisma:app-event"),
  },
);
