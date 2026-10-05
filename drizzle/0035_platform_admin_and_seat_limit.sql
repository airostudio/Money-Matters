-- Platform admin section + two-person account sharing (seat limit).
-- See docs/security.md (platform admin), docs/database.md, docs/roadmap.md.

-- 1. Case-insensitive email uniqueness. There is no email-verification step,
--    so a look-alike (`Typhoon.Tall69@x` vs `typhoon.tall69@x`) of a
--    privileged address must be impossible at the database level.
--    Duplicate-by-case rows are NEVER merged or deleted silently: if any exist
--    this migration aborts and names them so a human can decide which account
--    is real, then re-run.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(e || ' (' || n || ' accounts)', ', ')
    INTO dupes
    FROM (
      SELECT lower(btrim(email)) AS e, count(*) AS n
      FROM users
      GROUP BY lower(btrim(email))
      HAVING count(*) > 1
    ) d;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add case-insensitive email uniqueness: these emails are registered more than once differing only by case/whitespace: %. Resolve them manually (decide which account is real) and re-run the migration.', dupes;
  END IF;
END
$$;
--> statement-breakpoint
-- Safe now: no two rows collide once normalised.
UPDATE "users" SET "email" = lower(btrim("email")) WHERE "email" <> lower(btrim("email"));
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalised" CHECK ("email" = lower(btrim("email")));
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"));
--> statement-breakpoint

-- 2. Suspension.
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;
--> statement-breakpoint

-- 3. Seat limit + plan tier.
CREATE TYPE "public"."plan_tier" AS ENUM('STANDARD', 'EXTENDED', 'COMPLIMENTARY');
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "seat_limit" integer DEFAULT 2 NOT NULL;
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan_tier" "plan_tier" DEFAULT 'STANDARD' NOT NULL;
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_seat_limit_positive" CHECK ("seat_limit" >= 1);
--> statement-breakpoint
-- Grandfathering: an organization that already has more than 2 active members
-- keeps all of them — its seat limit is set to its current member count so
-- nobody is locked out, but it cannot grow further without a platform admin
-- raising the limit.
UPDATE "organizations" o
SET "seat_limit" = c.n
FROM (
  SELECT "organization_id", count(*)::int AS n
  FROM "organization_memberships"
  WHERE "is_active" = true
  GROUP BY "organization_id"
  HAVING count(*) > 2
) c
WHERE o."id" = c."organization_id";
--> statement-breakpoint

-- 4. Platform-level append-only admin audit log. NOT tenant-scoped (no
--    organization_id column), so no RLS; isolation is by being reachable only
--    through the platform-admin gate. mm_app may only INSERT and SELECT.
CREATE TABLE "platform_admin_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_user_id" uuid NOT NULL,
  "admin_email" text NOT NULL,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "target_organization" uuid,
  "before" jsonb,
  "after" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_admin_audit_created_at_idx" ON "platform_admin_audit_logs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "platform_admin_audit_target_org_idx" ON "platform_admin_audit_logs" USING btree ("target_organization","created_at");
--> statement-breakpoint
CREATE INDEX "platform_admin_audit_action_idx" ON "platform_admin_audit_logs" USING btree ("action","created_at");
--> statement-breakpoint
GRANT SELECT, INSERT ON "platform_admin_audit_logs" TO mm_app;
