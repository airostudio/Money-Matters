-- Sales documents slice: customer credit notes, applying credit to invoices, unapplied receipts, payment receipts.
-- Schema + Row-Level Security + grants in one file. Read docs/security.md alongside this file.
--
-- customer_credit_notes / _lines : SELECT, INSERT, UPDATE, DELETE (drafts are editable/deletable; the service enforces it).
-- customer_credit_allocations    : SELECT, INSERT ONLY. Append-only: a mistaken application is reversed by a NEGATIVE row.
-- customer_payment_receipts      : SELECT, INSERT ONLY. A receipt is immutable once issued.

CREATE TYPE "public"."customer_credit_status" AS ENUM('DRAFT', 'APPROVED', 'PART_APPLIED', 'APPLIED', 'VOID');--> statement-breakpoint

CREATE TABLE "customer_credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_contact_id" uuid NOT NULL,
	"invoice_id" uuid,
	"credit_note_number" text NOT NULL,
	"issue_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"memo" text,
	"ar_account_id" uuid NOT NULL,
	"status" "customer_credit_status" DEFAULT 'DRAFT' NOT NULL,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"void_journal_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);--> statement-breakpoint
CREATE TABLE "customer_credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code_id" uuid,
	"product_id" uuid,
	"line_amount" numeric(19, 4) NOT NULL,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "customer_credit_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"applied_date" timestamp with time zone NOT NULL,
	"reverses_allocation_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	CONSTRAINT "customer_credit_allocations_amount_nonzero" CHECK ("amount" <> 0)
);--> statement-breakpoint
CREATE TABLE "customer_payment_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"receipt_number" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by_id" uuid
);--> statement-breakpoint

ALTER TABLE "payment_allocations" ADD COLUMN "applied_date" timestamp with time zone;--> statement-breakpoint
DROP INDEX "payment_allocations_payment_invoice_unique";--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_invoice_idx" ON "payment_allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint

ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_customer_contact_id_contacts_id_fk" FOREIGN KEY ("customer_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_ar_account_id_accounts_id_fk" FOREIGN KEY ("ar_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_notes" ADD CONSTRAINT "customer_credit_notes_void_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("void_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_note_lines" ADD CONSTRAINT "customer_credit_note_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_allocations" ADD CONSTRAINT "customer_credit_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_allocations" ADD CONSTRAINT "customer_credit_allocations_credit_note_id_customer_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."customer_credit_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_allocations" ADD CONSTRAINT "customer_credit_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_allocations" ADD CONSTRAINT "customer_credit_allocations_reverses_allocation_id_fk" FOREIGN KEY ("reverses_allocation_id") REFERENCES "public"."customer_credit_allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_receipts" ADD CONSTRAINT "customer_payment_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_receipts" ADD CONSTRAINT "customer_payment_receipts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "customer_credit_notes_org_number_unique" ON "customer_credit_notes" USING btree ("organization_id","credit_note_number");--> statement-breakpoint
CREATE INDEX "customer_credit_notes_org_status_idx" ON "customer_credit_notes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "customer_credit_notes_org_customer_idx" ON "customer_credit_notes" USING btree ("organization_id","customer_contact_id");--> statement-breakpoint
CREATE INDEX "customer_credit_notes_org_invoice_idx" ON "customer_credit_notes" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_note_lines_credit_line_unique" ON "customer_credit_note_lines" USING btree ("credit_note_id","line_number");--> statement-breakpoint
CREATE INDEX "customer_credit_note_lines_org_credit_idx" ON "customer_credit_note_lines" USING btree ("organization_id","credit_note_id");--> statement-breakpoint
CREATE INDEX "customer_credit_allocations_org_invoice_idx" ON "customer_credit_allocations" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "customer_credit_allocations_org_credit_idx" ON "customer_credit_allocations" USING btree ("organization_id","credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_allocations_reverses_unique" ON "customer_credit_allocations" USING btree ("reverses_allocation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payment_receipts_payment_unique" ON "customer_payment_receipts" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payment_receipts_org_number_unique" ON "customer_payment_receipts" USING btree ("organization_id","receipt_number");--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_credit_notes, customer_credit_note_lines TO mm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON customer_credit_allocations, customer_payment_receipts TO mm_app;--> statement-breakpoint

ALTER TABLE customer_credit_notes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_credit_notes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation_customer_credit_notes ON customer_credit_notes
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE customer_credit_note_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_credit_note_lines FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation_customer_credit_note_lines ON customer_credit_note_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE customer_credit_allocations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_credit_allocations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation_customer_credit_allocations ON customer_credit_allocations
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE customer_payment_receipts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_payment_receipts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation_customer_payment_receipts ON customer_payment_receipts
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
