-- Row-Level Security for Phase 6 Slice 2's AI draft-proposal table — same
-- pattern as drizzle/0010_expenses_row_level_security.sql and every other
-- tenant table's RLS migration; see docs/database.md §3 and
-- docs/security.md §2 for why FORCE is required and why grants are
-- role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  ai_draft_proposals
TO mm_app;

ALTER TABLE ai_draft_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_draft_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_ai_draft_proposals ON ai_draft_proposals
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
