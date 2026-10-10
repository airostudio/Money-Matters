-- Row-Level Security + grants for Phase 8 Slice 3 (payroll operations). Read docs/security.md alongside this file.
--
-- leave_requests:    SELECT, INSERT, UPDATE (status transitions, pay-run application). No DELETE: a request is
--                    cancelled or rejected, never erased.
-- payroll_payments:  SELECT, INSERT, and UPDATE of ONLY the reversal columns + status. A payment is never edited or
--                    deleted; the ledger effect of a mistaken one is undone by a reversing journal.

GRANT SELECT, INSERT, UPDATE ON leave_requests TO mm_app;
GRANT SELECT, INSERT ON payroll_payments TO mm_app;
GRANT UPDATE (status, reversal_journal_entry_id, reversed_at, reversed_by_id, reversal_reason) ON payroll_payments TO mm_app;

ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_leave_requests ON leave_requests
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE payroll_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_payroll_payments ON payroll_payments
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
