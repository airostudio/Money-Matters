CREATE TYPE "public"."document_extraction_status" AS ENUM('NOT_ATTEMPTED', 'EXTRACTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."expense_claim_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED', 'VOID');--> statement-breakpoint
CREATE TABLE "expense_claim_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"expense_claim_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"tax_code_id" uuid,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"category" text,
	"receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_user_id" uuid NOT NULL,
	"claim_number" text NOT NULL,
	"claim_date" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"currency" text NOT NULL,
	"memo" text,
	"status" "expense_claim_status" DEFAULT 'DRAFT' NOT NULL,
	"payable_account_id" uuid NOT NULL,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"reimbursement_journal_entry_id" uuid,
	"reimbursement_account_id" uuid,
	"void_journal_entry_id" uuid,
	"submitted_at" timestamp with time zone,
	"submitted_by_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by_id" uuid,
	"rejection_reason" text,
	"reimbursed_at" timestamp with time zone,
	"reimbursed_by_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_id" uuid,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "uploaded_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"uploaded_by_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"file_data" "bytea" NOT NULL,
	"extraction_status" "document_extraction_status" DEFAULT 'NOT_ATTEMPTED' NOT NULL,
	"extracted_data" jsonb,
	"extraction_model" text,
	"extraction_confidence" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_expense_claim_id_expense_claims_id_fk" FOREIGN KEY ("expense_claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_expense_account_id_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_receipt_id_uploaded_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."uploaded_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_payable_account_id_accounts_id_fk" FOREIGN KEY ("payable_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_reimbursement_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reimbursement_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_reimbursement_account_id_accounts_id_fk" FOREIGN KEY ("reimbursement_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_void_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("void_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploaded_receipts" ADD CONSTRAINT "uploaded_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_claim_lines_claim_line_unique" ON "expense_claim_lines" USING btree ("expense_claim_id","line_number");--> statement-breakpoint
CREATE INDEX "expense_claim_lines_org_claim_idx" ON "expense_claim_lines" USING btree ("organization_id","expense_claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_claims_org_claim_number_unique" ON "expense_claims" USING btree ("organization_id","claim_number");--> statement-breakpoint
CREATE INDEX "expense_claims_org_status_idx" ON "expense_claims" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "expense_claims_org_employee_idx" ON "expense_claims" USING btree ("organization_id","employee_user_id");--> statement-breakpoint
CREATE INDEX "uploaded_receipts_org_idx" ON "uploaded_receipts" USING btree ("organization_id");