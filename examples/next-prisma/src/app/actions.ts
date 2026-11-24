"use server";

import { auditAction } from "@auditstream/node/next";
import { headers } from "next/headers";
import { resolveAuditContext, resolveDemoActor } from "../lib/actor";
import { getPrisma } from "../lib/prisma";

const updateInvoiceInScope = auditAction(
  async (id: number, status: string) => {
    const prisma = getPrisma();
    const updated = await prisma.invoice.update({
      where: { id },
      data: { status },
    });
    return {
      id: updated.id,
      status: updated.status,
      total: updated.total.toString(),
    };
  },
  {
    actor: async () => resolveDemoActor(await headers()),
    context: async () => resolveAuditContext(await headers(), "examples/next-prisma:action"),
  },
);

/**
 * Next.js Server Action that updates an invoice status inside an `auditAction()` scope.
 */
export async function updateInvoiceStatus(
  id: number,
  status: string,
): Promise<{ readonly id: number; readonly status: string; readonly total: string }> {
  return updateInvoiceInScope(id, status);
}

/**
 * Form-bound wrapper for the Server Action so `src/app/page.tsx` can submit via HTML `<form>`.
 */
export async function updateInvoiceStatusForm(formData: FormData): Promise<void> {
  const id = Number.parseInt(String(formData.get("id") ?? ""), 10);
  const status = String(formData.get("status") ?? "").trim();
  if (!Number.isSafeInteger(id) || id <= 0 || status.length === 0) {
    return;
  }
  await updateInvoiceInScope(id, status);
}
