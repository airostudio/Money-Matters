CREATE TYPE "public"."ai_auto_execution_action_type" AS ENUM('RECURRING_INVOICE_AUTO_GENERATE', 'RECURRING_BILL_AUTO_GENERATE', 'BANK_RECONCILIATION_AUTO_MATCH');--> statement-breakpoint
CREATE TABLE "ai_auto_approved_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"action_type" "ai_auto_execution_action_type" NOT NULL,
	"enabled_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_auto_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"action_type" "ai_auto_execution_action_type" NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"confidence" numeric(4, 3),
	"model" text,
	"autonomy_level" integer NOT NULL,
	"triggered_by_user_id" uuid NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_auto_approved_actions" ADD CONSTRAINT "ai_auto_approved_actions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_auto_executions" ADD CONSTRAINT "ai_auto_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_auto_approved_actions_org_action_unique" ON "ai_auto_approved_actions" USING btree ("organization_id","action_type");--> statement-breakpoint
CREATE INDEX "ai_auto_executions_org_entity_idx" ON "ai_auto_executions" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ai_auto_executions_org_created_at_idx" ON "ai_auto_executions" USING btree ("organization_id","created_at");