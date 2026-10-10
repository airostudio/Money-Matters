CREATE TYPE "public"."project_status" AS ENUM('ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."timesheet_entry_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'INVOICED');--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"budgeted_hours" numeric(19, 2),
	"billing_rate" numeric(19, 4),
	"is_done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_contact_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" "project_status" DEFAULT 'ACTIVE' NOT NULL,
	"currency" text NOT NULL,
	"budgeted_revenue" numeric(19, 4) DEFAULT '0' NOT NULL,
	"budgeted_cost" numeric(19, 4) DEFAULT '0' NOT NULL,
	"default_hourly_rate" numeric(19, 4),
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"memo" text,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "timesheet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"entry_date" timestamp with time zone NOT NULL,
	"hours" numeric(19, 2) NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"notes" text,
	"billable" boolean DEFAULT true NOT NULL,
	"status" timesheet_entry_status DEFAULT 'DRAFT' NOT NULL,
	"billed_rate" numeric(19, 4),
	"invoice_id" uuid,
	"invoice_line_id" uuid,
	"submitted_at" timestamp with time zone,
	"submitted_by_id" uuid,
	"approved_at" timestamp with time zone,
	"approved_by_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_by_id" uuid,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_contact_id_contacts_id_fk" FOREIGN KEY ("customer_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_entries" ADD CONSTRAINT "timesheet_entries_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_tasks_org_project_idx" ON "project_tasks" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_code_unique" ON "projects" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "projects_org_status_idx" ON "projects" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "projects_org_customer_idx" ON "projects" USING btree ("organization_id","customer_contact_id");--> statement-breakpoint
CREATE INDEX "timesheet_entries_org_project_idx" ON "timesheet_entries" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "timesheet_entries_org_employee_idx" ON "timesheet_entries" USING btree ("organization_id","employee_user_id");--> statement-breakpoint
CREATE INDEX "timesheet_entries_org_status_idx" ON "timesheet_entries" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "timesheet_entries_unbilled_idx" ON "timesheet_entries" USING btree ("organization_id","project_id","status","billable");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_lines_org_project_idx" ON "bill_lines" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "expense_claim_lines_org_project_idx" ON "expense_claim_lines" USING btree ("organization_id","project_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_org_project_idx" ON "invoice_lines" USING btree ("organization_id","project_id");