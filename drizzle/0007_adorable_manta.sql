CREATE TYPE "public"."bill_status" AS ENUM('DRAFT', 'APPROVED', 'PART_PAID', 'PAID', 'VOID');--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
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
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_contact_id" uuid NOT NULL,
	"bill_number" text NOT NULL,
	"supplier_reference" text,
	"issue_date" timestamp with time zone NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"memo" text,
	"ap_account_id" uuid NOT NULL,
	"status" "bill_status" DEFAULT 'DRAFT' NOT NULL,
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
CREATE TABLE "supplier_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supplier_contact_id" uuid NOT NULL,
	"payment_date" timestamp with time zone NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"method" "payment_method" DEFAULT 'BANK_TRANSFER' NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"bank_account_id" uuid,
	"reference" text,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "tax_codes" ADD COLUMN "receivable_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_supplier_contact_id_contacts_id_fk" FOREIGN KEY ("supplier_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_ap_account_id_accounts_id_fk" FOREIGN KEY ("ap_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_void_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("void_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_supplier_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_contact_id_contacts_id_fk" FOREIGN KEY ("supplier_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_payment_account_id_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_lines_bill_line_unique" ON "bill_lines" USING btree ("bill_id","line_number");--> statement-breakpoint
CREATE INDEX "bill_lines_org_bill_idx" ON "bill_lines" USING btree ("organization_id","bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_org_bill_number_unique" ON "bills" USING btree ("organization_id","bill_number");--> statement-breakpoint
CREATE INDEX "bills_org_status_idx" ON "bills" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "bills_org_supplier_idx" ON "bills" USING btree ("organization_id","supplier_contact_id");--> statement-breakpoint
CREATE INDEX "bills_org_due_date_idx" ON "bills" USING btree ("organization_id","due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_allocations_payment_bill_unique" ON "supplier_payment_allocations" USING btree ("payment_id","bill_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_org_bill_idx" ON "supplier_payment_allocations" USING btree ("organization_id","bill_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_org_payment_idx" ON "supplier_payment_allocations" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_supplier_idx" ON "supplier_payments" USING btree ("organization_id","supplier_contact_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_date_idx" ON "supplier_payments" USING btree ("organization_id","payment_date");--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_receivable_account_id_accounts_id_fk" FOREIGN KEY ("receivable_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;