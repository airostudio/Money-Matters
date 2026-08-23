CREATE TYPE "public"."bank_feed_provider" AS ENUM('MANUAL');--> statement-breakpoint
CREATE TYPE "public"."bank_import_format" AS ENUM('CSV', 'OFX', 'QIF');--> statement-breakpoint
CREATE TYPE "public"."bank_transaction_status" AS ENUM('UNMATCHED', 'RECONCILED', 'EXCLUDED');--> statement-breakpoint
ALTER TYPE "public"."journal_entry_source_type" ADD VALUE 'BANK_TRANSACTION';--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"institution_name" text,
	"account_number_last4" text,
	"currency" text NOT NULL,
	"provider" "bank_feed_provider" DEFAULT 'MANUAL' NOT NULL,
	"external_account_id" text,
	"current_balance" numeric(19, 4),
	"current_balance_as_of" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"format" "bank_import_format" NOT NULL,
	"file_name" text,
	"row_count" integer NOT NULL,
	"imported_row_count" integer NOT NULL,
	"duplicate_row_count" integer DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid,
	"name" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"import_batch_id" uuid,
	"external_id" text NOT NULL,
	"posted_date" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"balance_after" numeric(19, 4),
	"raw_payload" jsonb,
	"status" "bank_transaction_status" DEFAULT 'UNMATCHED' NOT NULL,
	"categorized_account_id" uuid,
	"contact_id" uuid,
	"applied_rule_id" uuid,
	"matched_journal_line_id" uuid,
	"matched_by_id" uuid,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_import_batches" ADD CONSTRAINT "bank_import_batches_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_batch_id_bank_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."bank_import_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_categorized_account_id_accounts_id_fk" FOREIGN KEY ("categorized_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_applied_rule_id_bank_rules_id_fk" FOREIGN KEY ("applied_rule_id") REFERENCES "public"."bank_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matched_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("matched_journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_org_gl_account_unique" ON "bank_accounts" USING btree ("organization_id","gl_account_id");--> statement-breakpoint
CREATE INDEX "bank_import_batches_org_account_idx" ON "bank_import_batches" USING btree ("organization_id","bank_account_id");--> statement-breakpoint
CREATE INDEX "bank_rules_org_account_priority_idx" ON "bank_rules" USING btree ("organization_id","bank_account_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_account_external_id_unique" ON "bank_transactions" USING btree ("bank_account_id","external_id");--> statement-breakpoint
CREATE INDEX "bank_transactions_org_account_status_idx" ON "bank_transactions" USING btree ("organization_id","bank_account_id","status");--> statement-breakpoint
CREATE INDEX "bank_transactions_org_posted_date_idx" ON "bank_transactions" USING btree ("organization_id","posted_date");--> statement-breakpoint
CREATE INDEX "bank_transactions_matched_journal_line_idx" ON "bank_transactions" USING btree ("matched_journal_line_id");