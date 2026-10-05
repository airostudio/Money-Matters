CREATE TYPE "public"."client_request_side" AS ENUM('PRACTICE', 'CLIENT');
--> statement-breakpoint
CREATE TYPE "public"."client_request_status" AS ENUM('OPEN', 'ANSWERED', 'CLOSED');
--> statement-breakpoint
CREATE TYPE "public"."client_request_type" AS ENUM('QUERY', 'DOCUMENT_REQUEST');
--> statement-breakpoint
CREATE TYPE "public"."practice_deadline_frequency" AS ENUM('MONTHLY', 'QUARTERLY', 'ANNUAL');
--> statement-breakpoint
CREATE TYPE "public"."practice_link_status" AS ENUM('PENDING', 'ACTIVE', 'DECLINED', 'REVOKED', 'WITHDRAWN');
--> statement-breakpoint
CREATE TYPE "public"."practice_member_status" AS ENUM('ACTIVE', 'REMOVED');
--> statement-breakpoint
CREATE TYPE "public"."practice_role" AS ENUM('PARTNER', 'MANAGER', 'STAFF');
--> statement-breakpoint
CREATE TYPE "public"."practice_task_category" AS ENUM('BAS', 'TAX', 'PAYROLL', 'YEAR_END', 'REVIEW', 'BOOKKEEPING', 'OTHER');
--> statement-breakpoint
CREATE TYPE "public"."practice_task_priority" AS ENUM('LOW', 'NORMAL', 'HIGH');
--> statement-breakpoint
CREATE TYPE "public"."practice_task_status" AS ENUM('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');
--> statement-breakpoint
CREATE TYPE "public"."workpaper_adjustment_status" AS ENUM('PROPOSED', 'DISMISSED', 'POSTED');
--> statement-breakpoint
CREATE TYPE "public"."workpaper_kind" AS ENUM('BALANCE_SHEET_ACCOUNT_RECONCILIATION');
--> statement-breakpoint
CREATE TYPE "public"."workpaper_review_note_status" AS ENUM('OPEN', 'RESOLVED');
--> statement-breakpoint
CREATE TYPE "public"."workpaper_schedule_line_kind" AS ENUM('SUPPORTING_BALANCE', 'RECONCILING_ITEM');
--> statement-breakpoint
CREATE TYPE "public"."workpaper_signoff_step" AS ENUM('PREPARER', 'REVIEWER', 'REOPEN');
--> statement-breakpoint
CREATE TYPE "public"."workpaper_status" AS ENUM('DRAFT', 'IN_REVIEW', 'SIGNED_OFF');
--> statement-breakpoint
CREATE TABLE "client_health_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_organization_id" uuid NOT NULL,
	"state" text NOT NULL,
	"detail" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computed_by_user_id" uuid NOT NULL,
	"computed_by_role" text,
	"period_label" text,
	"lock_level" text,
	"books_percent" integer,
	"blocking_count" integer,
	"attention_count" integer,
	"unreconciled_count" integer,
	"uncategorised_count" integer,
	"draft_pay_runs" integer,
	"tax_locked_through" text
);
--> statement-breakpoint
CREATE TABLE "client_request_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_side" "client_request_side" NOT NULL,
	"body" text NOT NULL,
	"attachment_receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"practice_name" text NOT NULL,
	"type" "client_request_type" NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" "client_request_status" DEFAULT 'OPEN' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"due_date" date,
	"closed_at" timestamp with time zone,
	"closed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
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
CREATE TABLE "practice_client_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"practice_name" text NOT NULL,
	"status" "practice_link_status" DEFAULT 'PENDING' NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"responded_by_user_id" uuid,
	"responded_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_client_group_members" (
	"group_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_client_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_client_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_organization_id" uuid NOT NULL,
	"client_name" text NOT NULL,
	"client_slug" text NOT NULL,
	"status" "practice_link_status" DEFAULT 'PENDING' NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"assigned_user_id" uuid,
	"status_verified_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_deadline_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_organization_id" uuid,
	"name" text NOT NULL,
	"category" "practice_task_category" DEFAULT 'BAS' NOT NULL,
	"frequency" "practice_deadline_frequency" NOT NULL,
	"period_end_month" integer DEFAULT 12 NOT NULL,
	"due_months_after" integer DEFAULT 1 NOT NULL,
	"due_day" integer DEFAULT 28 NOT NULL,
	"priority" "practice_task_priority" DEFAULT 'NORMAL' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_deadline_templates_ranges" CHECK ("practice_deadline_templates"."period_end_month" BETWEEN 1 AND 12 AND "practice_deadline_templates"."due_months_after" BETWEEN 0 AND 12 AND "practice_deadline_templates"."due_day" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE TABLE "practice_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "practice_role" DEFAULT 'STAFF' NOT NULL,
	"status" "practice_member_status" DEFAULT 'ACTIVE' NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_partners" (
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_roster" (
	"practice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "practice_role" NOT NULL,
	"status" "practice_member_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practice_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_organization_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"due_date" date,
	"status" "practice_task_status" DEFAULT 'OPEN' NOT NULL,
	"priority" "practice_task_priority" DEFAULT 'NORMAL' NOT NULL,
	"category" "practice_task_category" DEFAULT 'OTHER' NOT NULL,
	"assigned_user_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" uuid,
	"template_id" uuid,
	"period_end" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "practices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpaper_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workpaper_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"description" text NOT NULL,
	"debit_account" text,
	"credit_account" text,
	"amount" numeric(19, 4) NOT NULL,
	"status" "workpaper_adjustment_status" DEFAULT 'PROPOSED' NOT NULL,
	"posted_reference" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpaper_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workpaper_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"file_data" "bytea" NOT NULL,
	"description" text,
	"uploaded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpaper_review_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workpaper_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"status" "workpaper_review_note_status" DEFAULT 'OPEN' NOT NULL,
	"author_user_id" uuid NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpaper_schedule_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workpaper_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"kind" "workpaper_schedule_line_kind" NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"amount" numeric(19, 4) NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpaper_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workpaper_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"step" "workpaper_signoff_step" NOT NULL,
	"user_id" uuid NOT NULL,
	"practice_role" "practice_role" NOT NULL,
	"reason" text,
	"single_staff_exception" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpaper_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workpaper_id" uuid NOT NULL,
	"practice_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"period_end" date NOT NULL,
	"ledger_balance" numeric(19, 4) NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by_user_id" uuid NOT NULL,
	"taken_by_role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpapers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"practice_id" uuid NOT NULL,
	"client_organization_id" uuid NOT NULL,
	"kind" "workpaper_kind" DEFAULT 'BALANCE_SHEET_ACCOUNT_RECONCILIATION' NOT NULL,
	"account_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text NOT NULL,
	"account_type" text NOT NULL,
	"currency" text NOT NULL,
	"period_end" date NOT NULL,
	"status" "workpaper_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"prepared_by_user_id" uuid NOT NULL,
	"ledger_balance" numeric(19, 4) NOT NULL,
	"snapshot_taken_at" timestamp with time zone NOT NULL,
	"snapshot_taken_by_user_id" uuid NOT NULL,
	"prior_workpaper_id" uuid,
	"prior_period_end" date,
	"prior_ledger_balance" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "client_health_snapshots_practice_client_unique" ON "client_health_snapshots" USING btree ("practice_id","client_organization_id");
--> statement-breakpoint
CREATE INDEX "client_request_messages_request_idx" ON "client_request_messages" USING btree ("request_id","created_at");
--> statement-breakpoint
CREATE INDEX "client_requests_org_status_idx" ON "client_requests" USING btree ("organization_id","status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "client_requests_id_org_unique" ON "client_requests" USING btree ("id","organization_id");
--> statement-breakpoint
CREATE INDEX "practice_audit_logs_practice_created_idx" ON "practice_audit_logs" USING btree ("practice_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_client_consents_org_practice_unique" ON "practice_client_consents" USING btree ("organization_id","practice_id");
--> statement-breakpoint
CREATE INDEX "practice_client_consents_org_status_idx" ON "practice_client_consents" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_client_group_members_unique" ON "practice_client_group_members" USING btree ("group_id","client_organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_client_groups_practice_name_unique" ON "practice_client_groups" USING btree ("practice_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_client_groups_id_practice_unique" ON "practice_client_groups" USING btree ("id","practice_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_client_links_practice_client_unique" ON "practice_client_links" USING btree ("practice_id","client_organization_id");
--> statement-breakpoint
CREATE INDEX "practice_client_links_practice_status_idx" ON "practice_client_links" USING btree ("practice_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_deadline_templates_id_practice_unique" ON "practice_deadline_templates" USING btree ("id","practice_id");
--> statement-breakpoint
CREATE INDEX "practice_deadline_templates_practice_idx" ON "practice_deadline_templates" USING btree ("practice_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_members_practice_user_unique" ON "practice_members" USING btree ("practice_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_members_mirror_unique" ON "practice_members" USING btree ("practice_id","user_id","role","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_partners_practice_user_unique" ON "practice_partners" USING btree ("practice_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_roster_practice_user_unique" ON "practice_roster" USING btree ("practice_id","user_id");
--> statement-breakpoint
CREATE INDEX "practice_tasks_practice_due_idx" ON "practice_tasks" USING btree ("practice_id","status","due_date");
--> statement-breakpoint
CREATE INDEX "practice_tasks_client_idx" ON "practice_tasks" USING btree ("practice_id","client_organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_tasks_template_period_unique" ON "practice_tasks" USING btree ("template_id","period_end");
--> statement-breakpoint
CREATE INDEX "workpaper_adjustments_workpaper_idx" ON "workpaper_adjustments" USING btree ("workpaper_id");
--> statement-breakpoint
CREATE INDEX "workpaper_evidence_workpaper_idx" ON "workpaper_evidence" USING btree ("workpaper_id");
--> statement-breakpoint
CREATE INDEX "workpaper_review_notes_workpaper_idx" ON "workpaper_review_notes" USING btree ("workpaper_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "workpaper_schedule_lines_line_unique" ON "workpaper_schedule_lines" USING btree ("workpaper_id","line_number");
--> statement-breakpoint
CREATE INDEX "workpaper_signoffs_workpaper_idx" ON "workpaper_signoffs" USING btree ("workpaper_id","created_at");
--> statement-breakpoint
CREATE INDEX "workpaper_snapshots_workpaper_idx" ON "workpaper_snapshots" USING btree ("workpaper_id","taken_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "workpapers_account_period_unique" ON "workpapers" USING btree ("practice_id","client_organization_id","account_id","period_end");
--> statement-breakpoint
CREATE UNIQUE INDEX "workpapers_id_practice_unique" ON "workpapers" USING btree ("id","practice_id");
--> statement-breakpoint
CREATE INDEX "workpapers_practice_status_idx" ON "workpapers" USING btree ("practice_id","status");
--> statement-breakpoint
ALTER TABLE "client_health_snapshots" ADD CONSTRAINT "client_health_snapshots_link_fk" FOREIGN KEY ("practice_id","client_organization_id") REFERENCES "public"."practice_client_links"("practice_id","client_organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_request_messages" ADD CONSTRAINT "client_request_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_request_messages" ADD CONSTRAINT "client_request_messages_attachment_receipt_id_uploaded_receipts_id_fk" FOREIGN KEY ("attachment_receipt_id") REFERENCES "public"."uploaded_receipts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_request_messages" ADD CONSTRAINT "client_request_messages_request_fk" FOREIGN KEY ("request_id","organization_id") REFERENCES "public"."client_requests"("id","organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_requests" ADD CONSTRAINT "client_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_audit_logs" ADD CONSTRAINT "practice_audit_logs_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_consents" ADD CONSTRAINT "practice_client_consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_consents" ADD CONSTRAINT "practice_client_consents_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_group_members" ADD CONSTRAINT "practice_client_group_members_group_fk" FOREIGN KEY ("group_id","practice_id") REFERENCES "public"."practice_client_groups"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_group_members" ADD CONSTRAINT "practice_client_group_members_link_fk" FOREIGN KEY ("practice_id","client_organization_id") REFERENCES "public"."practice_client_links"("practice_id","client_organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_groups" ADD CONSTRAINT "practice_client_groups_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_links" ADD CONSTRAINT "practice_client_links_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_links" ADD CONSTRAINT "practice_client_links_client_organization_id_organizations_id_fk" FOREIGN KEY ("client_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_client_links" ADD CONSTRAINT "practice_client_links_assignee_fk" FOREIGN KEY ("practice_id","assigned_user_id") REFERENCES "public"."practice_members"("practice_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_deadline_templates" ADD CONSTRAINT "practice_deadline_templates_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_deadline_templates" ADD CONSTRAINT "practice_deadline_templates_link_fk" FOREIGN KEY ("practice_id","client_organization_id") REFERENCES "public"."practice_client_links"("practice_id","client_organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_members" ADD CONSTRAINT "practice_members_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_members" ADD CONSTRAINT "practice_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_partners" ADD CONSTRAINT "practice_partners_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_partners" ADD CONSTRAINT "practice_partners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_roster" ADD CONSTRAINT "practice_roster_member_fk" FOREIGN KEY ("practice_id","user_id","role","status") REFERENCES "public"."practice_members"("practice_id","user_id","role","status") ON DELETE no action ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "practice_tasks" ADD CONSTRAINT "practice_tasks_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_tasks" ADD CONSTRAINT "practice_tasks_link_fk" FOREIGN KEY ("practice_id","client_organization_id") REFERENCES "public"."practice_client_links"("practice_id","client_organization_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_tasks" ADD CONSTRAINT "practice_tasks_assignee_fk" FOREIGN KEY ("practice_id","assigned_user_id") REFERENCES "public"."practice_members"("practice_id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_tasks" ADD CONSTRAINT "practice_tasks_template_fk" FOREIGN KEY ("template_id","practice_id") REFERENCES "public"."practice_deadline_templates"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practices" ADD CONSTRAINT "practices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpaper_adjustments" ADD CONSTRAINT "workpaper_adjustments_workpaper_fk" FOREIGN KEY ("workpaper_id","practice_id") REFERENCES "public"."workpapers"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpaper_evidence" ADD CONSTRAINT "workpaper_evidence_workpaper_fk" FOREIGN KEY ("workpaper_id","practice_id") REFERENCES "public"."workpapers"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpaper_review_notes" ADD CONSTRAINT "workpaper_review_notes_workpaper_fk" FOREIGN KEY ("workpaper_id","practice_id") REFERENCES "public"."workpapers"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpaper_schedule_lines" ADD CONSTRAINT "workpaper_schedule_lines_workpaper_fk" FOREIGN KEY ("workpaper_id","practice_id") REFERENCES "public"."workpapers"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpaper_signoffs" ADD CONSTRAINT "workpaper_signoffs_workpaper_fk" FOREIGN KEY ("workpaper_id","practice_id") REFERENCES "public"."workpapers"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpaper_snapshots" ADD CONSTRAINT "workpaper_snapshots_workpaper_fk" FOREIGN KEY ("workpaper_id","practice_id") REFERENCES "public"."workpapers"("id","practice_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpapers" ADD CONSTRAINT "workpapers_practice_id_practices_id_fk" FOREIGN KEY ("practice_id") REFERENCES "public"."practices"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workpapers" ADD CONSTRAINT "workpapers_link_fk" FOREIGN KEY ("practice_id","client_organization_id") REFERENCES "public"."practice_client_links"("practice_id","client_organization_id") ON DELETE no action ON UPDATE no action;
