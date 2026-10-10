CREATE TYPE "public"."consolidation_adjustment_kind" AS ENUM('ELIMINATION', 'ADJUSTMENT');
--> statement-breakpoint
CREATE TYPE "public"."entity_group_role" AS ENUM('PARENT', 'SUBSIDIARY');
--> statement-breakpoint
CREATE TYPE "public"."intercompany_kind" AS ENUM('RECEIVABLE', 'PAYABLE', 'LOAN_RECEIVABLE', 'LOAN_PAYABLE', 'REVENUE', 'EXPENSE');
--> statement-breakpoint
CREATE TABLE "entity_group_account_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"member_organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text NOT NULL,
	"group_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_group_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"type" "account_type" NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_group_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"group_account_id" uuid NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	CONSTRAINT "entity_group_adjustment_lines_one_sided" CHECK ("entity_group_adjustment_lines"."debit" >= 0 AND "entity_group_adjustment_lines"."credit" >= 0 AND ("entity_group_adjustment_lines"."debit" = 0 OR "entity_group_adjustment_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "entity_group_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" "consolidation_adjustment_kind" NOT NULL,
	"effective_date" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"reason" text NOT NULL,
	"reverses_adjustment_id" uuid,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_group_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
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
CREATE TABLE "entity_group_intercompany_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"member_organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text NOT NULL,
	"kind" "intercompany_kind" NOT NULL,
	"counterparty_organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_group_ic_accounts_not_self" CHECK ("entity_group_intercompany_accounts"."member_organization_id" <> "entity_group_intercompany_accounts"."counterparty_organization_id")
);
--> statement-breakpoint
CREATE TABLE "entity_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"member_organization_id" uuid NOT NULL,
	"role" "entity_group_role" DEFAULT 'SUBSIDIARY' NOT NULL,
	"is_included" boolean DEFAULT true NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_group_account_mappings_account_unique" ON "entity_group_account_mappings" USING btree ("group_id","member_organization_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_group_accounts_group_type_code_unique" ON "entity_group_accounts" USING btree ("group_id","type","code");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_group_accounts_id_group_unique" ON "entity_group_accounts" USING btree ("id","group_id");
--> statement-breakpoint
CREATE INDEX "entity_group_adjustment_lines_adjustment_idx" ON "entity_group_adjustment_lines" USING btree ("adjustment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_group_adjustments_id_group_unique" ON "entity_group_adjustments" USING btree ("id","group_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_group_adjustments_reverses_unique" ON "entity_group_adjustments" USING btree ("reverses_adjustment_id");
--> statement-breakpoint
CREATE INDEX "entity_group_adjustments_group_date_idx" ON "entity_group_adjustments" USING btree ("group_id","effective_date");
--> statement-breakpoint
CREATE INDEX "entity_group_audit_logs_group_created_idx" ON "entity_group_audit_logs" USING btree ("group_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_group_ic_accounts_account_unique" ON "entity_group_intercompany_accounts" USING btree ("group_id","member_organization_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_group_members_group_org_unique" ON "entity_group_members" USING btree ("group_id","member_organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_groups_owner_name_unique" ON "entity_groups" USING btree ("owner_user_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "entity_groups_id_owner_unique" ON "entity_groups" USING btree ("id","owner_user_id");
--> statement-breakpoint
ALTER TABLE "entity_group_account_mappings" ADD CONSTRAINT "entity_group_account_mappings_member_organization_id_organizations_id_fk" FOREIGN KEY ("member_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_account_mappings" ADD CONSTRAINT "entity_group_account_mappings_group_owner_fk" FOREIGN KEY ("group_id","owner_user_id") REFERENCES "public"."entity_groups"("id","owner_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_account_mappings" ADD CONSTRAINT "entity_group_account_mappings_group_account_fk" FOREIGN KEY ("group_account_id","group_id") REFERENCES "public"."entity_group_accounts"("id","group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_account_mappings" ADD CONSTRAINT "entity_group_account_mappings_member_fk" FOREIGN KEY ("group_id","member_organization_id") REFERENCES "public"."entity_group_members"("group_id","member_organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_accounts" ADD CONSTRAINT "entity_group_accounts_group_owner_fk" FOREIGN KEY ("group_id","owner_user_id") REFERENCES "public"."entity_groups"("id","owner_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_adjustment_lines" ADD CONSTRAINT "entity_group_adjustment_lines_group_owner_fk" FOREIGN KEY ("group_id","owner_user_id") REFERENCES "public"."entity_groups"("id","owner_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_adjustment_lines" ADD CONSTRAINT "entity_group_adjustment_lines_adjustment_fk" FOREIGN KEY ("adjustment_id","group_id") REFERENCES "public"."entity_group_adjustments"("id","group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_adjustment_lines" ADD CONSTRAINT "entity_group_adjustment_lines_group_account_fk" FOREIGN KEY ("group_account_id","group_id") REFERENCES "public"."entity_group_accounts"("id","group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_adjustments" ADD CONSTRAINT "entity_group_adjustments_group_owner_fk" FOREIGN KEY ("group_id","owner_user_id") REFERENCES "public"."entity_groups"("id","owner_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_audit_logs" ADD CONSTRAINT "entity_group_audit_logs_group_owner_fk" FOREIGN KEY ("group_id","owner_user_id") REFERENCES "public"."entity_groups"("id","owner_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_intercompany_accounts" ADD CONSTRAINT "entity_group_intercompany_accounts_member_organization_id_organizations_id_fk" FOREIGN KEY ("member_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_intercompany_accounts" ADD CONSTRAINT "entity_group_intercompany_accounts_counterparty_organization_id_organizations_id_fk" FOREIGN KEY ("counterparty_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_intercompany_accounts" ADD CONSTRAINT "entity_group_ic_accounts_group_owner_fk" FOREIGN KEY ("group_id","owner_user_id") REFERENCES "public"."entity_groups"("id","owner_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_intercompany_accounts" ADD CONSTRAINT "entity_group_ic_accounts_member_fk" FOREIGN KEY ("group_id","member_organization_id") REFERENCES "public"."entity_group_members"("group_id","member_organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_intercompany_accounts" ADD CONSTRAINT "entity_group_ic_accounts_counterparty_fk" FOREIGN KEY ("group_id","counterparty_organization_id") REFERENCES "public"."entity_group_members"("group_id","member_organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_members" ADD CONSTRAINT "entity_group_members_member_organization_id_organizations_id_fk" FOREIGN KEY ("member_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_group_members" ADD CONSTRAINT "entity_group_members_group_owner_fk" FOREIGN KEY ("group_id","owner_user_id") REFERENCES "public"."entity_groups"("id","owner_user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entity_groups" ADD CONSTRAINT "entity_groups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
