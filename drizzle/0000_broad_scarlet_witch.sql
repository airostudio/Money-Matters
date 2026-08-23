CREATE TYPE "public"."account_type" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('HUMAN', 'AI', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('CUSTOMER', 'SUPPLIER', 'BOTH');--> statement-breakpoint
CREATE TYPE "public"."fiscal_period_status" AS ENUM('OPEN', 'SOFT_LOCKED', 'HARD_LOCKED');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_source_type" AS ENUM('MANUAL', 'OPENING_BALANCE', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_status" AS ENUM('DRAFT', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('OWNER', 'ADMINISTRATOR', 'ACCOUNTANT', 'BOOKKEEPER', 'PAYROLL_MANAGER', 'ACCOUNTS_PAYABLE', 'ACCOUNTS_RECEIVABLE', 'MANAGER', 'EMPLOYEE', 'READ_ONLY');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"sub_type" text,
	"currency" text NOT NULL,
	"is_control_account" boolean DEFAULT false NOT NULL,
	"is_system_account" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"parent_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"approved_by_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_type" "audit_actor_type" DEFAULT 'HUMAN' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "contact_kind" NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"email" text,
	"phone" text,
	"tax_number" text,
	"billing_address" jsonb,
	"currency" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimal_places" integer DEFAULT 2 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimension_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"as_of_date" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"status" "fiscal_period_status" DEFAULT 'OPEN' NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by_id" uuid,
	"lock_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entry_number" text NOT NULL,
	"posting_date" timestamp with time zone NOT NULL,
	"memo" text,
	"status" "journal_entry_status" DEFAULT 'DRAFT' NOT NULL,
	"source_type" "journal_entry_source_type" DEFAULT 'MANUAL' NOT NULL,
	"fiscal_period_id" uuid,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "journal_line_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"dimension_id" uuid NOT NULL,
	"dimension_value_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"tax_code_id" uuid,
	"memo" text,
	"currency" text NOT NULL,
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"base_debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"base_credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"base_currency" text DEFAULT 'AUD' NOT NULL,
	"country" text DEFAULT 'AU' NOT NULL,
	"industry" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate" numeric(6, 4) NOT NULL,
	"jurisdiction" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_account_id_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_values" ADD CONSTRAINT "dimension_values_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_id_journal_entries_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_dimension_id_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."dimensions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line_dimensions" ADD CONSTRAINT "journal_line_dimensions_dimension_value_id_dimension_values_id_fk" FOREIGN KEY ("dimension_value_id") REFERENCES "public"."dimension_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_org_code_unique" ON "accounts" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "accounts_org_type_idx" ON "accounts" USING btree ("organization_id","type");--> statement-breakpoint
CREATE INDEX "approvals_org_entity_idx" ON "approvals" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_entity_idx" ON "audit_logs" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_at_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "contacts_org_kind_idx" ON "contacts" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "dimension_values_dimension_value_unique" ON "dimension_values" USING btree ("dimension_id","value");--> statement-breakpoint
CREATE UNIQUE INDEX "dimensions_org_key_unique" ON "dimensions" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "exchange_rates_lookup_idx" ON "exchange_rates" USING btree ("from_currency","to_currency","as_of_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_org_label_unique" ON "fiscal_periods" USING btree ("organization_id","label");--> statement-breakpoint
CREATE INDEX "fiscal_periods_org_dates_idx" ON "fiscal_periods" USING btree ("organization_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_org_entry_number_unique" ON "journal_entries" USING btree ("organization_id","entry_number");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reversal_of_unique" ON "journal_entries" USING btree ("reversal_of_id");--> statement-breakpoint
CREATE INDEX "journal_entries_org_posting_date_idx" ON "journal_entries" USING btree ("organization_id","posting_date");--> statement-breakpoint
CREATE INDEX "journal_entries_org_status_idx" ON "journal_entries" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_line_dimensions_line_dimension_unique" ON "journal_line_dimensions" USING btree ("journal_line_id","dimension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_lines_entry_line_unique" ON "journal_lines" USING btree ("journal_entry_id","line_number");--> statement-breakpoint
CREATE INDEX "journal_lines_org_account_idx" ON "journal_lines" USING btree ("organization_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_membership_org_user_unique" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "org_membership_user_idx" ON "organization_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_codes_org_code_effective_unique" ON "tax_codes" USING btree ("organization_id","code","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");