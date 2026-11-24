import {
  integer,
  numeric,
  type PgColumn,
  type PgTable,
  pgTable,
  text,
} from "drizzle-orm-v1/pg-core";

export type EngineInvoiceTableV1 = PgTable & {
  readonly id: PgColumn;
  readonly status: PgColumn;
  readonly total: PgColumn;
  readonly passwordHash: PgColumn;
};

export type EngineLineItemTableV1 = PgTable & {
  readonly id: PgColumn;
  readonly invoiceId: PgColumn;
  readonly qty: PgColumn;
};

export const invoice: EngineInvoiceTableV1 = pgTable("invoice", {
  id: integer("id").primaryKey(),
  status: text("status"),
  total: numeric("total"),
  passwordHash: text("password_hash"),
});

export const lineItem: EngineLineItemTableV1 = pgTable("line_item", {
  id: integer("id").primaryKey(),
  invoiceId: integer("invoice_id").references(() => invoice.id, { onDelete: "cascade" }),
  qty: integer("qty"),
});
