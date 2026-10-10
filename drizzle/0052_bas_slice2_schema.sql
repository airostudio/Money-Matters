CREATE TYPE "public"."bas_gst_treatment" AS ENUM('TAXABLE', 'GST_FREE', 'EXPORT', 'INPUT_TAXED', 'NOT_REPORTED');--> statement-breakpoint
CREATE TYPE "public"."bas_status" AS ENUM('DRAFT', 'FINALISED');--> statement-breakpoint
CREATE TYPE "public"."bas_frequency" AS ENUM('MONTHLY', 'QUARTERLY');--> statement-breakpoint
ALTER TABLE "tax_codes" ADD COLUMN "bas_treatment" "bas_gst_treatment";--> statement-breakpoint
ALTER TABLE "tax_codes" ADD COLUMN "bas_capital" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "bas_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"frequency" "bas_frequency" NOT NULL,
	"basis" text DEFAULT 'ACCRUAL' NOT NULL,
	"status" "bas_status" DEFAULT 'DRAFT' NOT NULL,
	"note" text,
	"report" jsonb,
	"content_hash" text,
	"warnings_acknowledged" boolean DEFAULT false NOT NULL,
	"period_lock_at_finalise" text,
	"finalised_at" timestamp with time zone,
	"finalised_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	CONSTRAINT "bas_statements_period_order" CHECK ("bas_statements"."period_end" >= "bas_statements"."period_start")
);
--> statement-breakpoint
CREATE TABLE "bas_lodgement_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bas_statement_id" uuid NOT NULL,
	"lodged_on" timestamp with time zone NOT NULL,
	"reference" text NOT NULL,
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bas_statements" ADD CONSTRAINT "bas_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bas_lodgement_records" ADD CONSTRAINT "bas_lodgement_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bas_lodgement_records" ADD CONSTRAINT "bas_lodgement_records_bas_statement_id_bas_statements_id_fk" FOREIGN KEY ("bas_statement_id") REFERENCES "public"."bas_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bas_statements_org_period_idx" ON "bas_statements" USING btree ("organization_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "bas_statements_id_org_unique" ON "bas_statements" USING btree ("id","organization_id");--> statement-breakpoint
CREATE INDEX "bas_lodgement_records_statement_idx" ON "bas_lodgement_records" USING btree ("organization_id","bas_statement_id");
