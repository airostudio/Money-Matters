CREATE TYPE "public"."payment_run_status" AS ENUM('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."supplier_credit_status" AS ENUM('DRAFT', 'APPROVED', 'PART_APPLIED', 'APPLIED', 'VOID');--> statement-breakpoint
CREATE TABLE "bill_recurring_source" (
	"bill_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_run_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"supplier_payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_number" text NOT NULL,
	"status" "payment_run_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"memo" text,
	"total_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_id" uuid,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code_id" uuid,
	"line_amount" numeric(19, 4) NOT NULL,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"quantity_received" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"quantity_received" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"received_date" timestamp with time zone NOT NULL,
	"memo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_contact_id" uuid NOT NULL,
	"po_number" text NOT NULL,
	"issue_date" timestamp with time zone NOT NULL,
	"expected_date" timestamp with time zone,
	"currency" text NOT NULL,
	"memo" text,
	"status" "purchase_order_status" DEFAULT 'DRAFT' NOT NULL,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"sent_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_id" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "recurring_bill_template_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_bill_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_contact_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"ap_account_id" uuid NOT NULL,
	"memo" text,
	"frequency" "recurring_frequency" NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"max_occurrences" integer,
	"occurrences_generated" integer DEFAULT 0 NOT NULL,
	"next_run_date" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier_credit_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier_credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code_id" uuid,
	"line_amount" numeric(19, 4) NOT NULL,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_contact_id" uuid NOT NULL,
	"credit_note_number" text NOT NULL,
	"issue_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"memo" text,
	"ap_account_id" uuid NOT NULL,
	"status" "supplier_credit_status" DEFAULT 'DRAFT' NOT NULL,
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
);
--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_recurring_source" ADD CONSTRAINT "bill_recurring_source_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_recurring_source" ADD CONSTRAINT "bill_recurring_source_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_recurring_source" ADD CONSTRAINT "bill_recurring_source_template_id_recurring_bill_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."recurring_bill_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_items" ADD CONSTRAINT "payment_run_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_items" ADD CONSTRAINT "payment_run_items_payment_run_id_payment_runs_id_fk" FOREIGN KEY ("payment_run_id") REFERENCES "public"."payment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_items" ADD CONSTRAINT "payment_run_items_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_items" ADD CONSTRAINT "payment_run_items_supplier_payment_id_supplier_payments_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_payment_account_id_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipt_lines" ADD CONSTRAINT "purchase_order_receipt_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipt_lines" ADD CONSTRAINT "purchase_order_receipt_lines_receipt_id_purchase_order_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."purchase_order_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipt_lines" ADD CONSTRAINT "purchase_order_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_receipts" ADD CONSTRAINT "purchase_order_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_contact_id_contacts_id_fk" FOREIGN KEY ("supplier_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_template_lines" ADD CONSTRAINT "recurring_bill_template_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_template_lines" ADD CONSTRAINT "recurring_bill_template_lines_template_id_recurring_bill_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."recurring_bill_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_template_lines" ADD CONSTRAINT "recurring_bill_template_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_template_lines" ADD CONSTRAINT "recurring_bill_template_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_templates" ADD CONSTRAINT "recurring_bill_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_templates" ADD CONSTRAINT "recurring_bill_templates_supplier_contact_id_contacts_id_fk" FOREIGN KEY ("supplier_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_bill_templates" ADD CONSTRAINT "recurring_bill_templates_ap_account_id_accounts_id_fk" FOREIGN KEY ("ap_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_allocations" ADD CONSTRAINT "supplier_credit_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_allocations" ADD CONSTRAINT "supplier_credit_allocations_credit_note_id_supplier_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."supplier_credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_allocations" ADD CONSTRAINT "supplier_credit_allocations_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_note_lines" ADD CONSTRAINT "supplier_credit_note_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_note_lines" ADD CONSTRAINT "supplier_credit_note_lines_credit_note_id_supplier_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."supplier_credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_note_lines" ADD CONSTRAINT "supplier_credit_note_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_note_lines" ADD CONSTRAINT "supplier_credit_note_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_supplier_contact_id_contacts_id_fk" FOREIGN KEY ("supplier_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_ap_account_id_accounts_id_fk" FOREIGN KEY ("ap_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_void_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("void_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_recurring_source_org_template_idx" ON "bill_recurring_source" USING btree ("organization_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_run_items_run_bill_unique" ON "payment_run_items" USING btree ("payment_run_id","bill_id");--> statement-breakpoint
CREATE INDEX "payment_run_items_org_run_idx" ON "payment_run_items" USING btree ("organization_id","payment_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_runs_org_run_number_unique" ON "payment_runs" USING btree ("organization_id","run_number");--> statement-breakpoint
CREATE INDEX "payment_runs_org_status_idx" ON "payment_runs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_po_line_unique" ON "purchase_order_lines" USING btree ("purchase_order_id","line_number");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_org_po_idx" ON "purchase_order_lines" USING btree ("organization_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_order_receipt_lines_org_receipt_idx" ON "purchase_order_receipt_lines" USING btree ("organization_id","receipt_id");--> statement-breakpoint
CREATE INDEX "purchase_order_receipts_org_po_idx" ON "purchase_order_receipts" USING btree ("organization_id","purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_org_po_number_unique" ON "purchase_orders" USING btree ("organization_id","po_number");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_status_idx" ON "purchase_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_supplier_idx" ON "purchase_orders" USING btree ("organization_id","supplier_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_bill_template_lines_template_line_unique" ON "recurring_bill_template_lines" USING btree ("template_id","line_number");--> statement-breakpoint
CREATE INDEX "recurring_bill_template_lines_org_template_idx" ON "recurring_bill_template_lines" USING btree ("organization_id","template_id");--> statement-breakpoint
CREATE INDEX "recurring_bill_templates_org_active_next_run_idx" ON "recurring_bill_templates" USING btree ("organization_id","is_active","next_run_date");--> statement-breakpoint
CREATE INDEX "recurring_bill_templates_org_supplier_idx" ON "recurring_bill_templates" USING btree ("organization_id","supplier_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_allocations_credit_bill_unique" ON "supplier_credit_allocations" USING btree ("credit_note_id","bill_id");--> statement-breakpoint
CREATE INDEX "supplier_credit_allocations_org_bill_idx" ON "supplier_credit_allocations" USING btree ("organization_id","bill_id");--> statement-breakpoint
CREATE INDEX "supplier_credit_allocations_org_credit_idx" ON "supplier_credit_allocations" USING btree ("organization_id","credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_note_lines_credit_line_unique" ON "supplier_credit_note_lines" USING btree ("credit_note_id","line_number");--> statement-breakpoint
CREATE INDEX "supplier_credit_note_lines_org_credit_idx" ON "supplier_credit_note_lines" USING btree ("organization_id","credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_notes_org_number_unique" ON "supplier_credit_notes" USING btree ("organization_id","credit_note_number");--> statement-breakpoint
CREATE INDEX "supplier_credit_notes_org_status_idx" ON "supplier_credit_notes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "supplier_credit_notes_org_supplier_idx" ON "supplier_credit_notes" USING btree ("organization_id","supplier_contact_id");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_receipt_id_uploaded_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."uploaded_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;