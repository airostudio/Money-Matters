CREATE TABLE "organization_invite_index" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"code_prefix" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"used_at" timestamp with time zone,
	"used_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "archived_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "archive_reason" text;--> statement-breakpoint
-- The composite foreign key from organization_invite_index needs this unique index to exist first.
CREATE UNIQUE INDEX "organization_invites_id_org_unique" ON "organization_invites" USING btree ("id","organization_id");--> statement-breakpoint
ALTER TABLE "organization_invite_index" ADD CONSTRAINT "organization_invite_index_invite_org_fk" FOREIGN KEY ("id","organization_id") REFERENCES "public"."organization_invites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invites" ADD CONSTRAINT "organization_invites_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invite_index_code_hash_unique" ON "organization_invite_index" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "organization_invites_org_created_idx" ON "organization_invites" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;