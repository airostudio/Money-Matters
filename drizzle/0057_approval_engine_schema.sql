CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"document_type" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"min_amount" numeric(19, 4),
	"max_amount" numeric(19, 4),
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"allow_same_person_multiple_steps" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_policies_type_check" CHECK ("approval_policies"."document_type" IN ('SUPPLIER_BILL','EXPENSE_CLAIM','PAYMENT_RUN')),
	CONSTRAINT "approval_policies_band_check" CHECK ("approval_policies"."min_amount" IS NULL OR "approval_policies"."max_amount" IS NULL OR "approval_policies"."max_amount" > "approval_policies"."min_amount")
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_label" text NOT NULL,
	"document_summary" text,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text NOT NULL,
	"policy_id" uuid,
	"policy_name" text NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"excluded_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"overridden_by_id" uuid,
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_status_check" CHECK ("approval_requests"."status" IN ('PENDING','APPROVED','REJECTED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"name" text NOT NULL,
	"required_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_approvals" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"opened_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "approval_steps_status_check" CHECK ("approval_steps"."status" IN ('PENDING','APPROVED','REJECTED','CANCELLED','SKIPPED')),
	CONSTRAINT "approval_steps_count_check" CHECK ("approval_steps"."required_approvals" >= 1)
);
--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"step_id" uuid,
	"decided_by_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"comment" text,
	"decider_role" text NOT NULL,
	"repeat_approver" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_decisions_decision_check" CHECK ("approval_decisions"."decision" IN ('APPROVE','REJECT','OVERRIDE_APPROVE','OVERRIDE_REJECT','REASSIGN'))
);
--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_step_id_approval_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."approval_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_policies_org_type_idx" ON "approval_policies" USING btree ("organization_id","document_type","priority");--> statement-breakpoint
CREATE INDEX "approval_requests_org_doc_idx" ON "approval_requests" USING btree ("organization_id","document_type","document_id","requested_at");--> statement-breakpoint
CREATE INDEX "approval_requests_org_status_idx" ON "approval_requests" USING btree ("organization_id","status","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_unique" ON "approval_requests" USING btree ("organization_id","document_type","document_id") WHERE "approval_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "approval_steps_request_idx" ON "approval_steps" USING btree ("request_id","step_index");--> statement-breakpoint
CREATE INDEX "approval_steps_org_status_idx" ON "approval_steps" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "approval_decisions_request_idx" ON "approval_decisions" USING btree ("request_id","created_at");
