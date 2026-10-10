ALTER TYPE "public"."pay_run_status" ADD VALUE 'REVERSED';--> statement-breakpoint
CREATE TYPE "public"."leave_type" AS ENUM('ANNUAL', 'PERSONAL');--> statement-breakpoint
CREATE TYPE "public"."leave_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payroll_payment_kind" AS ENUM('NET_WAGES', 'SUPER', 'PAYG');--> statement-breakpoint
CREATE TYPE "public"."payroll_payment_status" AS ENUM('POSTED', 'REVERSED');--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "reversal_journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "reversed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD COLUMN "annual_leave_taken" numeric(10, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD COLUMN "personal_leave_taken" numeric(10, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD COLUMN "annual_leave_balance_after" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD COLUMN "personal_leave_balance_after" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type" "leave_type" NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"hours" numeric(10, 4) NOT NULL,
	"reason" text,
	"status" "leave_request_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"applied_pay_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_requests_hours_positive" CHECK ("leave_requests"."hours" > 0),
	CONSTRAINT "leave_requests_date_order" CHECK ("leave_requests"."end_date" >= "leave_requests"."start_date")
);
--> statement-breakpoint
CREATE TABLE "payroll_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "payroll_payment_kind" NOT NULL,
	"pay_run_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"payment_date" timestamp with time zone NOT NULL,
	"liability_account_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"reference" text,
	"status" "payroll_payment_status" DEFAULT 'POSTED' NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"reversal_journal_entry_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversed_by_id" uuid,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid NOT NULL,
	CONSTRAINT "payroll_payments_amount_positive" CHECK ("payroll_payments"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_applied_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("applied_pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_liability_account_id_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_bank_account_id_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_payments" ADD CONSTRAINT "payroll_payments_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_requests_org_employee_idx" ON "leave_requests" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE INDEX "leave_requests_org_status_idx" ON "leave_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "payroll_payments_org_kind_idx" ON "payroll_payments" USING btree ("organization_id","kind","status");--> statement-breakpoint
CREATE INDEX "payroll_payments_org_pay_run_idx" ON "payroll_payments" USING btree ("organization_id","pay_run_id");
