CREATE TYPE "public"."period_close_status" AS ENUM('NOT_STARTED', 'IN_PROGRESS', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."period_lock_event_type" AS ENUM('LOCKED', 'LEVEL_LOWERED', 'REOPENED', 'POSTING_OVERRIDE', 'MIGRATED');--> statement-breakpoint
ALTER TYPE "public"."fiscal_period_status" ADD VALUE 'ADVISOR_LOCKED';--> statement-breakpoint
ALTER TYPE "public"."fiscal_period_status" ADD VALUE 'TAX_LOCKED';--> statement-breakpoint
CREATE TABLE "close_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_close_id" uuid NOT NULL,
	"check_key" text NOT NULL,
	"signed_by_id" uuid NOT NULL,
	"signed_by_name" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "period_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"cycle" integer DEFAULT 1 NOT NULL,
	"status" "period_close_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_by_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"lock_level_applied" "fiscal_period_status",
	"acknowledged_attention_count" integer DEFAULT 0 NOT NULL,
	"checklist_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "period_lock_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"period_close_id" uuid,
	"event_type" "period_lock_event_type" NOT NULL,
	"from_level" "fiscal_period_status" NOT NULL,
	"to_level" "fiscal_period_status" NOT NULL,
	"reason" text NOT NULL,
	"acknowledgement" text,
	"actor_user_id" uuid,
	"actor_role" text,
	"journal_entry_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "lock_override_level" "fiscal_period_status";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "lock_override_reason" text;--> statement-breakpoint
ALTER TABLE "close_signoffs" ADD CONSTRAINT "close_signoffs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_signoffs" ADD CONSTRAINT "close_signoffs_period_close_id_period_closes_id_fk" FOREIGN KEY ("period_close_id") REFERENCES "public"."period_closes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_closes" ADD CONSTRAINT "period_closes_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_lock_events" ADD CONSTRAINT "period_lock_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_lock_events" ADD CONSTRAINT "period_lock_events_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_lock_events" ADD CONSTRAINT "period_lock_events_period_close_id_period_closes_id_fk" FOREIGN KEY ("period_close_id") REFERENCES "public"."period_closes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "close_signoffs_cycle_check_unique" ON "close_signoffs" USING btree ("period_close_id","check_key");--> statement-breakpoint
CREATE UNIQUE INDEX "period_closes_period_cycle_unique" ON "period_closes" USING btree ("fiscal_period_id","cycle");--> statement-breakpoint
CREATE INDEX "period_closes_org_period_idx" ON "period_closes" USING btree ("organization_id","fiscal_period_id");--> statement-breakpoint
CREATE INDEX "period_lock_events_org_period_idx" ON "period_lock_events" USING btree ("organization_id","fiscal_period_id","created_at");
