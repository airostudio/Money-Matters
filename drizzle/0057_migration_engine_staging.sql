CREATE TABLE "migration_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'STAGED' NOT NULL,
	"file_name" text,
	"file_hash" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"rolled_back_by_id" uuid,
	CONSTRAINT "migration_batches_kind_check" CHECK ("migration_batches"."kind" IN ('CHART_OF_ACCOUNTS', 'CONTACTS', 'OPENING_BALANCES', 'OPEN_INVOICES', 'OPEN_BILLS', 'OPENING_STOCK')),
	CONSTRAINT "migration_batches_status_check" CHECK ("migration_batches"."status" IN ('STAGED', 'IMPORTING', 'IMPORTED', 'FAILED', 'ROLLED_BACK', 'DISCARDED'))
);
--> statement-breakpoint
CREATE TABLE "migration_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"normalized" jsonb,
	"natural_key" text,
	"status" text DEFAULT 'VALID' NOT NULL,
	"errors" jsonb,
	"entity_type" text,
	"entity_id" uuid,
	"entity_action" text,
	CONSTRAINT "migration_rows_status_check" CHECK ("migration_rows"."status" IN ('VALID', 'ERROR', 'IMPORTED', 'SKIPPED_DUPLICATE', 'FAILED', 'ROLLED_BACK'))
);
--> statement-breakpoint
ALTER TABLE "migration_batches" ADD CONSTRAINT "migration_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_rows" ADD CONSTRAINT "migration_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_batches_id_org_unique" ON "migration_batches" USING btree ("id","organization_id");
--> statement-breakpoint
ALTER TABLE "migration_rows" ADD CONSTRAINT "migration_rows_batch_org_fk" FOREIGN KEY ("batch_id","organization_id") REFERENCES "public"."migration_batches"("id","organization_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "migration_batches_org_created_idx" ON "migration_batches" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_batches_live_file_unique" ON "migration_batches" USING btree ("organization_id","kind","file_hash") WHERE "migration_batches"."status" IN ('STAGED', 'IMPORTING', 'IMPORTED', 'FAILED');
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_rows_batch_row_unique" ON "migration_rows" USING btree ("batch_id","row_number");
--> statement-breakpoint
CREATE INDEX "migration_rows_org_key_idx" ON "migration_rows" USING btree ("organization_id","natural_key");
