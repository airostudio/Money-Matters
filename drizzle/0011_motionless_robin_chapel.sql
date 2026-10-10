CREATE TYPE "public"."quote_status" AS ENUM('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'CONVERTED');--> statement-breakpoint
CREATE TYPE "public"."recurring_frequency" AS ENUM('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY');--> statement-breakpoint
CREATE TABLE "invoice_recurring_source" (
	"invoice_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code_id" uuid,
	"line_amount" numeric(19, 4) NOT NULL,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_contact_id" uuid NOT NULL,
	"quote_number" text NOT NULL,
	"issue_date" timestamp with time zone NOT NULL,
	"expiry_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"memo" text,
	"status" "quote_status" DEFAULT 'DRAFT' NOT NULL,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by_id" uuid,
	"declined_at" timestamp with time zone,
	"declined_by_id" uuid,
	"decline_reason" text,
	"converted_invoice_id" uuid,
	"converted_at" timestamp with time zone,
	"converted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "recurring_invoice_template_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"tax_code_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoice_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_contact_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"ar_account_id" uuid NOT NULL,
	"memo" text,
	"frequency" "recurring_frequency" NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"max_occurrences" integer,
	"occurrences_generated" integer DEFAULT 0 NOT NULL,
	"next_run_date" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "invoice_recurring_source" ADD CONSTRAINT "invoice_recurring_source_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_recurring_source" ADD CONSTRAINT "invoice_recurring_source_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_recurring_source" ADD CONSTRAINT "invoice_recurring_source_template_id_recurring_invoice_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."recurring_invoice_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_contact_id_contacts_id_fk" FOREIGN KEY ("customer_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_converted_invoice_id_invoices_id_fk" FOREIGN KEY ("converted_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_template_lines" ADD CONSTRAINT "recurring_invoice_template_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_template_lines" ADD CONSTRAINT "recurring_invoice_template_lines_template_id_recurring_invoice_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."recurring_invoice_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_template_lines" ADD CONSTRAINT "recurring_invoice_template_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_template_lines" ADD CONSTRAINT "recurring_invoice_template_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD CONSTRAINT "recurring_invoice_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD CONSTRAINT "recurring_invoice_templates_customer_contact_id_contacts_id_fk" FOREIGN KEY ("customer_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD CONSTRAINT "recurring_invoice_templates_ar_account_id_accounts_id_fk" FOREIGN KEY ("ar_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_recurring_source_org_template_idx" ON "invoice_recurring_source" USING btree ("organization_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_lines_quote_line_unique" ON "quote_lines" USING btree ("quote_id","line_number");--> statement-breakpoint
CREATE INDEX "quote_lines_org_quote_idx" ON "quote_lines" USING btree ("organization_id","quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_org_quote_number_unique" ON "quotes" USING btree ("organization_id","quote_number");--> statement-breakpoint
CREATE INDEX "quotes_org_status_idx" ON "quotes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "quotes_org_customer_idx" ON "quotes" USING btree ("organization_id","customer_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_invoice_template_lines_template_line_unique" ON "recurring_invoice_template_lines" USING btree ("template_id","line_number");--> statement-breakpoint
CREATE INDEX "recurring_invoice_template_lines_org_template_idx" ON "recurring_invoice_template_lines" USING btree ("organization_id","template_id");--> statement-breakpoint
CREATE INDEX "recurring_invoice_templates_org_active_next_run_idx" ON "recurring_invoice_templates" USING btree ("organization_id","is_active","next_run_date");--> statement-breakpoint
CREATE INDEX "recurring_invoice_templates_org_customer_idx" ON "recurring_invoice_templates" USING btree ("organization_id","customer_contact_id");