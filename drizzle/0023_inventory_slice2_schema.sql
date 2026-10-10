CREATE TYPE "public"."inventory_costing_method" AS ENUM('WEIGHTED_AVERAGE');--> statement-breakpoint
CREATE TYPE "public"."inventory_movement_type" AS ENUM('PURCHASE', 'SALE', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('TRACKED_INVENTORY', 'NON_INVENTORY', 'SERVICE');--> statement-breakpoint
CREATE TABLE "inventory_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_delta" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"reason" text NOT NULL,
	"adjustment_account_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"movement_type" "inventory_movement_type" NOT NULL,
	"quantity_delta" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"total_value" numeric(19, 4) NOT NULL,
	"balance_quantity_after" numeric(19, 4) NOT NULL,
	"balance_average_cost_after" numeric(19, 4) NOT NULL,
	"invoice_line_id" uuid,
	"bill_line_id" uuid,
	"adjustment_id" uuid,
	"journal_entry_id" uuid,
	"memo" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "product_type" NOT NULL,
	"costing_method" "inventory_costing_method" DEFAULT 'WEIGHTED_AVERAGE' NOT NULL,
	"sell_price" numeric(19, 4),
	"revenue_account_id" uuid NOT NULL,
	"purchase_account_id" uuid,
	"inventory_asset_account_id" uuid,
	"cogs_account_id" uuid,
	"quantity_on_hand" numeric(19, 4) DEFAULT '0' NOT NULL,
	"average_unit_cost" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reorder_point" numeric(19, 4),
	"reorder_quantity" numeric(19, 4),
	"preferred_supplier_contact_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_adjustment_account_id_accounts_id_fk" FOREIGN KEY ("adjustment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_bill_line_id_bill_lines_id_fk" FOREIGN KEY ("bill_line_id") REFERENCES "public"."bill_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_adjustment_id_inventory_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."inventory_adjustments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_purchase_account_id_accounts_id_fk" FOREIGN KEY ("purchase_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_inventory_asset_account_id_accounts_id_fk" FOREIGN KEY ("inventory_asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_cogs_account_id_accounts_id_fk" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_preferred_supplier_contact_id_contacts_id_fk" FOREIGN KEY ("preferred_supplier_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_adjustments_org_product_idx" ON "inventory_adjustments" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_org_product_idx" ON "inventory_movements" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_org_product_created_idx" ON "inventory_movements" USING btree ("organization_id","product_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_sku_unique" ON "products" USING btree ("organization_id","sku");--> statement-breakpoint
CREATE INDEX "products_org_type_idx" ON "products" USING btree ("organization_id","type");--> statement-breakpoint
CREATE INDEX "products_org_active_idx" ON "products" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "products_org_reorder_idx" ON "products" USING btree ("organization_id","type","is_active");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_lines_org_product_idx" ON "bill_lines" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_org_product_idx" ON "invoice_lines" USING btree ("organization_id","product_id");