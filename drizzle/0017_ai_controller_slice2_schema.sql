CREATE TYPE "public"."ai_draft_proposal_status" AS ENUM('PENDING', 'CONFIRMED', 'DISMISSED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."ai_draft_proposal_type" AS ENUM('INVOICE', 'BILL', 'JOURNAL_ENTRY');--> statement-breakpoint
CREATE TABLE "ai_draft_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"proposal_type" "ai_draft_proposal_type" NOT NULL,
	"status" "ai_draft_proposal_status" DEFAULT 'PENDING' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"model" text NOT NULL,
	"conversation_question" text NOT NULL,
	"payload" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"result_entity_id" uuid,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "ai_autonomy_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_draft_proposals" ADD CONSTRAINT "ai_draft_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_draft_proposals_org_idx" ON "ai_draft_proposals" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_draft_proposals_org_status_idx" ON "ai_draft_proposals" USING btree ("organization_id","status");