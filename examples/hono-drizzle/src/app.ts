import { auditstream } from "@auditstream/node/hono";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppDatabase } from "./db.js";
import { invoice, lineItem } from "./schema.js";

interface CreateInvoiceBody {
  readonly status?: string;
  readonly total?: string;
}

interface UpdateInvoiceBody {
  readonly status?: string;
  readonly total?: string;
}

interface FinalizeInvoiceBody {
  readonly description?: string;
  readonly amount?: string;
  readonly simulateRollback?: boolean;
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

class DemoSavepointRollback extends Error {
  constructor() {
    super("Simulated savepoint rollback");
  }
}

/**
 * Builds the Hono HTTP application wired with `@auditstream/node/hono` middleware and Drizzle routes.
 */
export function createApp(db: AppDatabase): Hono {
  const app = new Hono();

  app.use(
    "*",
    auditstream({
      // Demo-only actor resolution: real applications must read the actor from a verified session.
      actor: (c) => {
        const userId = c.req.header("x-demo-user")?.trim();
        if (!userId) {
          return undefined;
        }
        return { type: "user", id: userId };
      },
      context: (c) => {
        const requestId = c.req.header("x-request-id");
        return requestId && /^[A-Za-z0-9._-]{1,64}$/.test(requestId)
          ? { requestId, source: "examples/hono-drizzle" }
          : { source: "examples/hono-drizzle" };
      },
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/invoices", async (c) => {
    const body = (await c.req.json<CreateInvoiceBody>().catch(() => ({}))) as CreateInvoiceBody;
    const status =
      typeof body.status === "string" && body.status.length > 0 ? body.status : "draft";
    const total = typeof body.total === "string" && body.total.length > 0 ? body.total : "0.00";

    const [created] = await db.insert(invoice).values({ status, total }).returning();

    if (!created) {
      return c.json({ error: "Failed to create invoice" }, 500);
    }

    return c.json(created, 201);
  });

  app.patch("/invoices/:id", async (c) => {
    const id = parsePositiveInt(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid invoice id" }, 400);
    }

    const body = (await c.req.json<UpdateInvoiceBody>().catch(() => ({}))) as UpdateInvoiceBody;
    const updates: { status?: string; total?: string } = {};
    if (typeof body.status === "string" && body.status.length > 0) {
      updates.status = body.status;
    }
    if (typeof body.total === "string" && body.total.length > 0) {
      updates.total = body.total;
    }
    if (Object.keys(updates).length === 0) {
      return c.json({ error: "Provide at least one field to update" }, 400);
    }

    const [updated] = await db.update(invoice).set(updates).where(eq(invoice.id, id)).returning();

    if (!updated) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    return c.json(updated);
  });

  app.post("/invoices/:id/finalize", async (c) => {
    const id = parsePositiveInt(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid invoice id" }, 400);
    }

    const body = (await c.req.json<FinalizeInvoiceBody>().catch(() => ({}))) as FinalizeInvoiceBody;
    const description =
      typeof body.description === "string" && body.description.length > 0
        ? body.description
        : "Finalized balance";
    const amount =
      typeof body.amount === "string" && body.amount.length > 0 ? body.amount : "100.00";
    const simulateRollback = body.simulateRollback === true;

    const result = await db.transaction(async (tx) => {
      const [updatedInvoice] = await tx
        .update(invoice)
        .set({ status: "finalized", total: amount })
        .where(eq(invoice.id, id))
        .returning();

      if (!updatedInvoice) {
        return null;
      }

      // Nested tx.transaction() creates a PostgreSQL SAVEPOINT inside the active actor scope.
      const createdItem = await tx.transaction(async (sp) => {
        const [item] = await sp
          .insert(lineItem)
          .values({ invoiceId: id, description, amount })
          .returning();
        return item;
      });

      let rolledBackOptionalItem = false;
      if (simulateRollback) {
        try {
          await tx.transaction(async (sp) => {
            await sp.insert(lineItem).values({
              invoiceId: id,
              description: "Rolled back adjustment",
              amount: "1.00",
            });
            throw new DemoSavepointRollback();
          });
        } catch (err) {
          if (err instanceof DemoSavepointRollback) {
            rolledBackOptionalItem = true;
          } else {
            throw err;
          }
        }
      }

      return {
        invoice: updatedInvoice,
        lineItem: createdItem ?? null,
        rolledBackOptionalItem,
      };
    });

    if (!result) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    return c.json(result);
  });

  app.delete("/invoices/:id", async (c) => {
    const id = parsePositiveInt(c.req.param("id"));
    if (id === null) {
      return c.json({ error: "Invalid invoice id" }, 400);
    }

    const [deleted] = await db
      .delete(invoice)
      .where(eq(invoice.id, id))
      .returning({ id: invoice.id });

    if (!deleted) {
      return c.json({ error: "Invoice not found" }, 404);
    }

    return c.json({ deleted: true, id: deleted.id });
  });

  return app;
}
