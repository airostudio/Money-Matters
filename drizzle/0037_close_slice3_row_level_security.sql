-- Row-Level Security + grants + legacy-lock mapping for Phase 9 Slice 3
-- (Month-End Close and the period-lock override workflow). Same pattern as
-- every prior slice's RLS migration (e.g. 0034); see docs/database.md §3 and
-- docs/security.md §2 for why FORCE is required and why grants are role-scoped.

-- period_closes: a close cycle moves IN_PROGRESS -> CLOSED, so UPDATE is
-- granted; there is no reason for the application to ever DELETE one.
GRANT SELECT, INSERT, UPDATE ON period_closes TO mm_app;

ALTER TABLE period_closes ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_closes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_period_closes ON period_closes
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- close_signoffs: a sign-off is created or revoked (revocation is itself
-- audited in audit_logs), never edited — so INSERT/DELETE/SELECT, no UPDATE.
GRANT SELECT, INSERT, DELETE ON close_signoffs TO mm_app;

ALTER TABLE close_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE close_signoffs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_close_signoffs ON close_signoffs
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- period_lock_events: APPEND-ONLY. mm_app may only INSERT and SELECT; an
-- UPDATE, DELETE or TRUNCATE is refused by Postgres itself ("permission
-- denied"), exactly as for platform_admin_audit_logs (0035). A test connects
-- as the real restricted role and proves it.
GRANT SELECT, INSERT ON period_lock_events TO mm_app;

ALTER TABLE period_lock_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_lock_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_period_lock_events ON period_lock_events
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- Legacy mapping. Before this slice a locked period was OPEN / SOFT_LOCKED /
-- HARD_LOCKED, and BOTH locked values rejected every posting by every actor
-- (PostingService: `status !== 'OPEN'` -> PeriodLockedError). The new
-- SOFT_LOCKED level is weaker (an authorised role may post with a reason), so
-- leaving legacy SOFT_LOCKED rows as-is would silently LOOSEN an existing
-- lock. They are therefore carried over as HARD_LOCKED — the level with
-- identical posting behaviour — and the original value is preserved in the
-- history. Nothing is ever loosened by this migration; a person with
-- period:reopen_hard can lower it through the audited reopen workflow.
-- (Uses only enum values that existed before this slice: new enum values
-- cannot be referenced in the transaction that adds them.)
INSERT INTO period_lock_events
  (organization_id, fiscal_period_id, event_type, from_level, to_level, reason, actor_user_id, metadata)
SELECT
  organization_id,
  id,
  'MIGRATED',
  status,
  'HARD_LOCKED',
  CASE
    WHEN status = 'SOFT_LOCKED' THEN
      'Migrated from the legacy SOFT_LOCKED status (which blocked all postings) to HARD_LOCKED so that no existing lock is loosened.'
    ELSE
      'Existing HARD_LOCKED period carried over unchanged when lock levels were introduced.'
  END,
  locked_by_id,
  jsonb_build_object('legacyStatus', status::text, 'legacyLockReason', lock_reason, 'legacyLockedAt', locked_at)
FROM fiscal_periods
WHERE status IN ('SOFT_LOCKED', 'HARD_LOCKED');

UPDATE fiscal_periods SET status = 'HARD_LOCKED', updated_at = now() WHERE status = 'SOFT_LOCKED';
