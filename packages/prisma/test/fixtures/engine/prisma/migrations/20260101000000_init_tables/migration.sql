CREATE TABLE "public"."invoice" (
    "id" INTEGER NOT NULL,
    "status" TEXT,
    "total" DECIMAL,
    "password_hash" TEXT,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."line_item" (
    "id" INTEGER NOT NULL,
    "invoice_id" INTEGER,
    "qty" INTEGER,

    CONSTRAINT "line_item_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."line_item"
    ADD CONSTRAINT "line_item_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "public"."invoice"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

GRANT USAGE ON SCHEMA "public" TO "app_user";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "public"."invoice", "public"."line_item" TO "app_user";
