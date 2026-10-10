-- Row-Level Security + grants for Phase 9 Slice 5 (accountant practice
-- management and workpapers, master spec s.42/s.43). Read docs/security.md
-- section 13 alongside this file.
--
-- Two scoping models, both single-variable, neither with a bypass:
--
--  A. PRACTICE-scoped tables (carry `practice_id`, no `organization_id`). The
--     one session variable is `app.current_user_id`, set by withUserScope().
--     A row is reachable only when the table `practice_members` has an ACTIVE
--     row for THAT user in the row's practice. `practice_members` is therefore
--     the gate, and it is protected so the check cannot recurse:
--       * practice_partners is an ANCHOR: own-row policy only (no sub-select).
--       * practice_members' SELECT is "my own row, or any row of a practice I
--         am a partner of" - one sub-select, onto the trivial anchor only.
--       * every other practice table asks "is there an ACTIVE practice_members
--         row for me in this practice?" - a sub-select onto practice_members,
--         whose own policy only reaches the trivial anchor. No policy
--         references its own table through a policy that itself has a
--         sub-select, so Postgres never reports infinite recursion.
--     A user who is not an active member of the practice sees and writes
--     nothing in any of them, even by calling withUserScope directly.
--
--  B. TENANT-scoped tables (practice_client_consents, client_requests,
--     client_request_messages): they belong to the CLIENT organization and use
--     the ordinary `app.current_org_id` policy, exactly like every other
--     tenant table.
--
-- There is NO multi-valued predicate, no `= ANY`, no SECURITY DEFINER function,
-- no BYPASSRLS and no policy that mentions both session variables. A practice
-- member gets NO access to a client's books from these policies: client data is
-- only ever read through the client's own tenant tables, inside
-- withTenant(clientId), using the staff member's real membership role there.
-- Append-only tables are granted SELECT + INSERT only; a test connects as the
-- real restricted role and proves UPDATE/DELETE/TRUNCATE are refused.

-- practices: visible to its creator and its ACTIVE staff; created by anyone for themselves; renamed by a partner.
GRANT SELECT, INSERT, UPDATE ON practices TO mm_app;
ALTER TABLE practices ENABLE ROW LEVEL SECURITY;
ALTER TABLE practices FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practices_select ON practices FOR SELECT USING (created_by_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid OR EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practices.id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practices_insert ON practices FOR INSERT WITH CHECK (created_by_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY practice_scope_practices_update ON practices FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practices.id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)) WITH CHECK (EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practices.id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid));

-- practice_partners: the ANCHOR. Own-row SELECT only. A founder can add themselves exactly once (while they have no member row);
-- a partner can promote another; only the partner themselves can delete their own row (step down).
GRANT SELECT, INSERT, DELETE ON practice_partners TO mm_app;
ALTER TABLE practice_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_partners FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_partners_select ON practice_partners FOR SELECT USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY practice_scope_practice_partners_insert ON practice_partners FOR INSERT WITH CHECK ((user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND EXISTS (SELECT 1 FROM practices pr WHERE pr.id = practice_partners.practice_id AND pr.created_by_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) AND NOT EXISTS (SELECT 1 FROM practice_members pm0 WHERE pm0.practice_id = practice_partners.practice_id AND pm0.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)) OR EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practice_partners.practice_id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid));
CREATE POLICY practice_scope_practice_partners_delete ON practice_partners FOR DELETE USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- practice_members: the GATE. SELECT = my own row, or any row of a practice I am a partner of.
-- INSERT = the founder's own first row, or a partner adding someone. UPDATE = a partner, or a member leaving (status REMOVED only).
GRANT SELECT, INSERT, UPDATE ON practice_members TO mm_app;
ALTER TABLE practice_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_members FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_members_select ON practice_members FOR SELECT USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid OR EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practice_members.practice_id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid));
CREATE POLICY practice_scope_practice_members_insert ON practice_members FOR INSERT WITH CHECK ((user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND role = 'PARTNER' AND status = 'ACTIVE' AND invited_by_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practice_members.practice_id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)) OR (EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practice_members.practice_id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) AND invited_by_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid));
CREATE POLICY practice_scope_practice_members_update ON practice_members FOR UPDATE USING (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid OR EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practice_members.practice_id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid)) WITH CHECK (EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practice_members.practice_id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) OR (user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND status = 'REMOVED'));

-- practice_roster: the colleague directory, a read-only mirror kept equal to practice_members by a cascading composite foreign key.
GRANT SELECT, INSERT ON practice_roster TO mm_app;
ALTER TABLE practice_roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_roster FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_roster_select ON practice_roster FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_roster.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_roster_insert ON practice_roster FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_roster.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM practice_partners pp WHERE pp.practice_id = practice_roster.practice_id AND pp.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid));

-- practice_audit_logs: APPEND-ONLY. INSERT must also carry the caller as the actor.
GRANT SELECT, INSERT ON practice_audit_logs TO mm_app;
ALTER TABLE practice_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_audit_logs_select ON practice_audit_logs FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_audit_logs.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_audit_logs_insert ON practice_audit_logs FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_audit_logs.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND actor_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- practice_client_links: a link is never deleted (its history matters); revoked/withdrawn is a status.
GRANT SELECT, INSERT, UPDATE ON practice_client_links TO mm_app;
ALTER TABLE practice_client_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_client_links FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_client_links_select ON practice_client_links FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_links.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_client_links_insert ON practice_client_links FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_links.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_client_links_update ON practice_client_links FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_links.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_links.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

GRANT SELECT, INSERT, UPDATE, DELETE ON practice_client_groups TO mm_app;
ALTER TABLE practice_client_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_client_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_client_groups_select ON practice_client_groups FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_groups.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_client_groups_insert ON practice_client_groups FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_groups.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_client_groups_update ON practice_client_groups FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_groups.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_groups.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_client_groups_delete ON practice_client_groups FOR DELETE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_groups.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

GRANT SELECT, INSERT, DELETE ON practice_client_group_members TO mm_app;
ALTER TABLE practice_client_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_client_group_members FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_client_group_members_select ON practice_client_group_members FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_group_members.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_client_group_members_insert ON practice_client_group_members FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_group_members.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_client_group_members_delete ON practice_client_group_members FOR DELETE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_client_group_members.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

-- client_health_snapshots: the latest refresh per (practice, client).
GRANT SELECT, INSERT, UPDATE ON client_health_snapshots TO mm_app;
ALTER TABLE client_health_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_health_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_client_health_snapshots_select ON client_health_snapshots FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = client_health_snapshots.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_client_health_snapshots_insert ON client_health_snapshots FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = client_health_snapshots.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_client_health_snapshots_update ON client_health_snapshots FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = client_health_snapshots.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = client_health_snapshots.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

GRANT SELECT, INSERT, UPDATE ON practice_deadline_templates TO mm_app;
ALTER TABLE practice_deadline_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_deadline_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_deadline_templates_select ON practice_deadline_templates FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_deadline_templates.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_deadline_templates_insert ON practice_deadline_templates FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_deadline_templates.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_deadline_templates_update ON practice_deadline_templates FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_deadline_templates.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_deadline_templates.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

GRANT SELECT, INSERT, UPDATE ON practice_tasks TO mm_app;
ALTER TABLE practice_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_practice_tasks_select ON practice_tasks FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_tasks.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_tasks_insert ON practice_tasks FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_tasks.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_practice_tasks_update ON practice_tasks FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_tasks.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = practice_tasks.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

-- workpapers: never deleted; a signed-off paper is changed only through the audited reopen.
GRANT SELECT, INSERT, UPDATE ON workpapers TO mm_app;
ALTER TABLE workpapers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpapers FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_workpapers_select ON workpapers FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpapers.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpapers_insert ON workpapers FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpapers.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpapers_update ON workpapers FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpapers.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpapers.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

-- workpaper_snapshots: APPEND-ONLY history of every ledger-balance pull.
GRANT SELECT, INSERT ON workpaper_snapshots TO mm_app;
ALTER TABLE workpaper_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpaper_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_workpaper_snapshots_select ON workpaper_snapshots FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_snapshots.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpaper_snapshots_insert ON workpaper_snapshots FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_snapshots.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

-- workpaper_schedule_lines: the reconciliation schedule. Writes are refused once the workpaper is SIGNED_OFF.
GRANT SELECT, INSERT, UPDATE, DELETE ON workpaper_schedule_lines TO mm_app;
ALTER TABLE workpaper_schedule_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpaper_schedule_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_workpaper_schedule_lines_select ON workpaper_schedule_lines FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_schedule_lines.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpaper_schedule_lines_insert ON workpaper_schedule_lines FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_schedule_lines.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_schedule_lines.workpaper_id AND w.practice_id = workpaper_schedule_lines.practice_id AND w.status <> 'SIGNED_OFF'));
CREATE POLICY practice_scope_workpaper_schedule_lines_update ON workpaper_schedule_lines FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_schedule_lines.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_schedule_lines.workpaper_id AND w.practice_id = workpaper_schedule_lines.practice_id AND w.status <> 'SIGNED_OFF')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_schedule_lines.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_schedule_lines.workpaper_id AND w.practice_id = workpaper_schedule_lines.practice_id AND w.status <> 'SIGNED_OFF'));
CREATE POLICY practice_scope_workpaper_schedule_lines_delete ON workpaper_schedule_lines FOR DELETE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_schedule_lines.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_schedule_lines.workpaper_id AND w.practice_id = workpaper_schedule_lines.practice_id AND w.status <> 'SIGNED_OFF'));

-- workpaper_evidence: evidence attachments (bytea, the document-storage pattern). Frozen once SIGNED_OFF.
GRANT SELECT, INSERT, DELETE ON workpaper_evidence TO mm_app;
ALTER TABLE workpaper_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpaper_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_workpaper_evidence_select ON workpaper_evidence FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_evidence.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpaper_evidence_insert ON workpaper_evidence FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_evidence.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_evidence.workpaper_id AND w.practice_id = workpaper_evidence.practice_id AND w.status <> 'SIGNED_OFF'));
CREATE POLICY practice_scope_workpaper_evidence_delete ON workpaper_evidence FOR DELETE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_evidence.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_evidence.workpaper_id AND w.practice_id = workpaper_evidence.practice_id AND w.status <> 'SIGNED_OFF'));

-- workpaper_adjustments: proposed adjustments, recorded as notes - never posted by this system. Frozen once SIGNED_OFF.
GRANT SELECT, INSERT, UPDATE ON workpaper_adjustments TO mm_app;
ALTER TABLE workpaper_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpaper_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_workpaper_adjustments_select ON workpaper_adjustments FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_adjustments.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpaper_adjustments_insert ON workpaper_adjustments FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_adjustments.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_adjustments.workpaper_id AND w.practice_id = workpaper_adjustments.practice_id AND w.status <> 'SIGNED_OFF'));
CREATE POLICY practice_scope_workpaper_adjustments_update ON workpaper_adjustments FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_adjustments.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_adjustments.workpaper_id AND w.practice_id = workpaper_adjustments.practice_id AND w.status <> 'SIGNED_OFF')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_adjustments.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_adjustments.workpaper_id AND w.practice_id = workpaper_adjustments.practice_id AND w.status <> 'SIGNED_OFF'));

-- workpaper_review_notes: a note's text is immutable (column-level UPDATE grant covers only the resolution fields); history is kept.
GRANT SELECT, INSERT ON workpaper_review_notes TO mm_app;
GRANT UPDATE (status, resolved_by_user_id, resolved_at, resolution_comment) ON workpaper_review_notes TO mm_app;
ALTER TABLE workpaper_review_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpaper_review_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_workpaper_review_notes_select ON workpaper_review_notes FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_review_notes.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpaper_review_notes_insert ON workpaper_review_notes FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_review_notes.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_review_notes.workpaper_id AND w.practice_id = workpaper_review_notes.practice_id AND w.status <> 'SIGNED_OFF') AND author_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY practice_scope_workpaper_review_notes_update ON workpaper_review_notes FOR UPDATE USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_review_notes.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND EXISTS (SELECT 1 FROM workpapers w WHERE w.id = workpaper_review_notes.workpaper_id AND w.practice_id = workpaper_review_notes.practice_id AND w.status <> 'SIGNED_OFF')) WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_review_notes.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));

-- workpaper_signoffs: APPEND-ONLY sign-off / reopen history; the signer must be the caller.
GRANT SELECT, INSERT ON workpaper_signoffs TO mm_app;
ALTER TABLE workpaper_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpaper_signoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY practice_scope_workpaper_signoffs_select ON workpaper_signoffs FOR SELECT USING (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_signoffs.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE'));
CREATE POLICY practice_scope_workpaper_signoffs_insert ON workpaper_signoffs FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM practice_members pm WHERE pm.practice_id = workpaper_signoffs.practice_id AND pm.user_id = nullif(current_setting('app.current_user_id', true), '')::uuid AND pm.status = 'ACTIVE') AND user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- TENANT-scoped tables: the ordinary organization policy.
GRANT SELECT, INSERT, UPDATE ON practice_client_consents TO mm_app;
ALTER TABLE practice_client_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_client_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_practice_client_consents ON practice_client_consents
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON client_requests TO mm_app;
ALTER TABLE client_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_client_requests ON client_requests
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON client_request_messages TO mm_app;
ALTER TABLE client_request_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_request_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_client_request_messages ON client_request_messages
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

