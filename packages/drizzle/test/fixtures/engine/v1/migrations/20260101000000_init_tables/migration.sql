CREATE TABLE "invoice" (
  "id" integer PRIMARY KEY NOT NULL,
  "status" text,
  "total" numeric,
  "password_hash" text
);
--> statement-breakpoint
CREATE TABLE "line_item" (
  "id" integer PRIMARY KEY NOT NULL,
  "invoice_id" integer REFERENCES "invoice"("id") ON DELETE CASCADE,
  "qty" integer
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "public"."invoice", "public"."line_item" TO "app_user";
