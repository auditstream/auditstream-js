import { integer, numeric, type PgColumn, type PgTable, pgTable, text } from "drizzle-orm/pg-core";

export type EngineInvoiceTable = PgTable & {
  readonly id: PgColumn;
  readonly status: PgColumn;
  readonly total: PgColumn;
  readonly passwordHash: PgColumn;
};

export type EngineLineItemTable = PgTable & {
  readonly id: PgColumn;
  readonly invoiceId: PgColumn;
  readonly qty: PgColumn;
};

export const invoice: EngineInvoiceTable = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
  total: numeric("total"),
  passwordHash: text("password_hash"),
});

export const lineItem: EngineLineItemTable = pgTable("line_item", {
  id: integer("id").primaryKey(),
  invoiceId: integer("invoice_id").references(() => invoice.id, { onDelete: "cascade" }),
  qty: integer("qty"),
});
