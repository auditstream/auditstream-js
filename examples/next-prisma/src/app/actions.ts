"use server";

import { auditAction } from "@auditstream/node/next";
import { headers } from "next/headers";
import { resolveAuditContext, resolveDemoActor } from "../lib/actor";
import { getPrisma } from "../lib/prisma";

const MAX_INVOICE_ID = 2_147_483_647;
const MAX_STATUS_LENGTH = 64;

function isWellFormedString(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function validateInvoiceUpdate(
  id: unknown,
  status: unknown,
): { readonly id: number; readonly status: string } | null {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || id > MAX_INVOICE_ID) {
    return null;
  }
  if (typeof status !== "string") {
    return null;
  }
  const normalizedStatus = status.trim();
  if (
    normalizedStatus.length === 0 ||
    normalizedStatus.length > MAX_STATUS_LENGTH ||
    !isWellFormedString(normalizedStatus) ||
    /\p{Cc}/u.test(normalizedStatus)
  ) {
    return null;
  }
  return { id, status: normalizedStatus };
}

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
 * Validates `id` and `status` at runtime because exported `"use server"` actions are public
 * HTTP endpoints callable directly with untrusted arguments.
 */
export async function updateInvoiceStatus(
  id: number,
  status: string,
): Promise<{ readonly id: number; readonly status: string; readonly total: string }> {
  const validated = validateInvoiceUpdate(id, status);
  if (validated === null) {
    throw new Error(
      `Invalid invoice update: id must be a positive 32-bit integer and status must be 1-${MAX_STATUS_LENGTH} printable characters`,
    );
  }
  return updateInvoiceInScope(validated.id, validated.status);
}

/**
 * Form-bound wrapper for the Server Action so `src/app/page.tsx` can submit via HTML `<form>`.
 */
export async function updateInvoiceStatusForm(formData: FormData): Promise<void> {
  if (!(formData instanceof FormData)) {
    return;
  }
  const rawId = formData.get("id");
  const rawStatus = formData.get("status");
  if (typeof rawId !== "string" || typeof rawStatus !== "string") {
    return;
  }
  const trimmedId = rawId.trim();
  if (!/^\d+$/.test(trimmedId)) {
    return;
  }
  const validated = validateInvoiceUpdate(Number.parseInt(trimmedId, 10), rawStatus);
  if (validated === null) {
    return;
  }
  await updateInvoiceInScope(validated.id, validated.status);
}
