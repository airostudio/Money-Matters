CREATE TYPE "public"."depreciation_method" AS ENUM('STRAIGHT_LINE');--> statement-breakpoint
CREATE TYPE "public"."fixed_asset_status" AS ENUM('ACTIVE', 'DISPOSED', 'WRITTEN_OFF');--> statement-breakpoint
CREATE TABLE "depreciation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"accumulated_depreciation_after" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_depreciation_method" "depreciation_method" DEFAULT 'STRAIGHT_LINE' NOT NULL,
	"default_useful_life_months" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_class_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"acquisition_date" timestamp with time zone NOT NULL,
	"acquisition_cost" numeric(19, 4) NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" "depreciation_method" DEFAULT 'STRAIGHT_LINE' NOT NULL,
	"residual_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" "fixed_asset_status" DEFAULT 'ACTIVE' NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"accumulated_depreciation_account_id" uuid NOT NULL,
	"depreciation_expense_account_id" uuid NOT NULL,
	"accumulated_depreciation" numeric(19, 4) DEFAULT '0' NOT NULL,
	"location_reference" text,
	"serial_number" text,
	"source_bill_line_id" uuid,
	"disposed_at" timestamp with time zone,
	"disposal_proceeds" numeric(19, 4),
	"disposal_gain_loss" numeric(19, 4),
	"disposal_journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_classes" ADD CONSTRAINT "fixed_asset_classes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_class_id_fixed_asset_classes_id_fk" FOREIGN KEY ("asset_class_id") REFERENCES "public"."fixed_asset_classes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulated_depreciation_account_id_accounts_id_fk" FOREIGN KEY ("accumulated_depreciation_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_depreciation_expense_account_id_accounts_id_fk" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_source_bill_line_id_bill_lines_id_fk" FOREIGN KEY ("source_bill_line_id") REFERENCES "public"."bill_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_entries_org_asset_period_unique" ON "depreciation_entries" USING btree ("organization_id","asset_id","period_start");--> statement-breakpoint
CREATE INDEX "depreciation_entries_org_asset_idx" ON "depreciation_entries" USING btree ("organization_id","asset_id");--> statement-breakpoint
CREATE INDEX "fixed_asset_classes_org_name_idx" ON "fixed_asset_classes" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "fixed_asset_classes_org_active_idx" ON "fixed_asset_classes" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "fixed_assets_org_status_idx" ON "fixed_assets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "fixed_assets_org_class_idx" ON "fixed_assets" USING btree ("organization_id","asset_class_id");--> statement-breakpoint
CREATE INDEX "fixed_assets_org_asset_account_idx" ON "fixed_assets" USING btree ("organization_id","asset_account_id");