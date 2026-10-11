-- Login security part 1 (master spec 47): Postgres-backed failed-sign-in throttling with temporary lockouts, an
-- append-only authentication event log, and the last-sign-in time. Read docs/security.md section 22 alongside this file.
--
-- Neither new table is a tenant or user-scoped table: sign-in happens BEFORE any tenant/user context exists, so a policy
-- keyed on app.current_org_id / app.current_user_id could not work (same reason as api_key_index, oauth_rate_windows and
-- platform_admin_audit_logs). They carry no organization_id / owner_user_id column, hold no secret and no raw email or IP
-- address (keyed HMACs only), and their exposure is bounded by GRANTs:
--   login_throttles  SELECT, INSERT, UPDATE, DELETE  (atomic counter upsert; stale rows are purged)
--   auth_events      SELECT, INSERT                  (append-only; no UPDATE, no DELETE)
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "login_throttles" (
	"bucket" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_level" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_throttles_updated_idx" ON "login_throttles" USING btree ("updated_at");--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"event" text NOT NULL,
	"email_hash" text,
	"ip_hash" text,
	"ip_prefix_hash" text,
	"user_agent_family" text,
	"new_device" boolean DEFAULT false NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_events_user_idx" ON "auth_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_events_event_idx" ON "auth_events" USING btree ("event","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "login_throttles" TO mm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "auth_events" TO mm_app;
