CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."employment_basis" AS ENUM('SALARY', 'HOURLY');--> statement-breakpoint
CREATE TYPE "public"."pay_frequency" AS ENUM('WEEKLY', 'FORTNIGHTLY', 'MONTHLY');--> statement-breakpoint
CREATE TYPE "public"."pay_run_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"employment_basis" "employment_basis" NOT NULL,
	"annual_salary" numeric(19, 4),
	"hourly_rate" numeric(19, 4),
	"standard_hours_per_week" numeric(6, 2) DEFAULT '38.00' NOT NULL,
	"pay_frequency" "pay_frequency" NOT NULL,
	"tax_free_threshold_claimed" boolean DEFAULT true NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"termination_date" timestamp with time zone,
	"status" "employee_status" DEFAULT 'ACTIVE' NOT NULL,
	"tfn" text,
	"super_fund_name" text,
	"super_fund_abn" text,
	"super_member_account_number" text,
	"bank_account_name" text,
	"bank_bsb" text,
	"bank_account_number" text,
	"annual_leave_balance_hours" numeric(10, 4) DEFAULT '0' NOT NULL,
	"personal_leave_balance_hours" numeric(10, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "pay_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pay_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"tax_rule_set_id" uuid NOT NULL,
	"hours_paid" numeric(10, 4) DEFAULT '0' NOT NULL,
	"gross_pay" numeric(19, 4) NOT NULL,
	"ordinary_time_earnings" numeric(19, 4) NOT NULL,
	"quarter_to_date_ote" numeric(19, 4) NOT NULL,
	"payg_withholding" numeric(19, 4) NOT NULL,
	"super_guarantee" numeric(19, 4) NOT NULL,
	"net_pay" numeric(19, 4) NOT NULL,
	"annual_leave_accrued" numeric(10, 4) NOT NULL,
	"personal_leave_accrued" numeric(10, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pay_frequency" "pay_frequency" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"pay_date" timestamp with time zone NOT NULL,
	"status" "pay_run_status" DEFAULT 'DRAFT' NOT NULL,
	"journal_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "payroll_tax_brackets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_set_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"threshold" numeric(19, 4) NOT NULL,
	"marginal_rate" numeric(6, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_tax_rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jurisdiction" text NOT NULL,
	"label" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone NOT NULL,
	"medicare_levy_rate" numeric(6, 4) NOT NULL,
	"medicare_levy_lower_threshold" numeric(19, 4) NOT NULL,
	"medicare_levy_upper_threshold" numeric(19, 4) NOT NULL,
	"sg_rate" numeric(6, 4) NOT NULL,
	"sg_quarterly_contribution_base_cap" numeric(19, 4),
	"requires_verification_note" text,
	"source_citation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD CONSTRAINT "pay_run_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD CONSTRAINT "pay_run_lines_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD CONSTRAINT "pay_run_lines_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD CONSTRAINT "pay_run_lines_tax_rule_set_id_payroll_tax_rule_sets_id_fk" FOREIGN KEY ("tax_rule_set_id") REFERENCES "public"."payroll_tax_rule_sets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_tax_brackets" ADD CONSTRAINT "payroll_tax_brackets_rule_set_id_payroll_tax_rule_sets_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."payroll_tax_rule_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employees_org_status_idx" ON "employees" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "employees_org_user_idx" ON "employees" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "pay_run_lines_org_pay_run_idx" ON "pay_run_lines" USING btree ("organization_id","pay_run_id");--> statement-breakpoint
CREATE INDEX "pay_run_lines_org_employee_idx" ON "pay_run_lines" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_run_lines_pay_run_employee_unique" ON "pay_run_lines" USING btree ("pay_run_id","employee_id");--> statement-breakpoint
CREATE INDEX "pay_runs_org_status_idx" ON "pay_runs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "pay_runs_org_period_idx" ON "pay_runs" USING btree ("organization_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_tax_brackets_rule_set_sequence_unique" ON "payroll_tax_brackets" USING btree ("rule_set_id","sequence");--> statement-breakpoint
CREATE INDEX "payroll_tax_rule_sets_jurisdiction_idx" ON "payroll_tax_rule_sets" USING btree ("jurisdiction","effective_from");