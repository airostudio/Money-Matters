-- Force row-level security so that even the table OWNER is subject to it.
--
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (migration 0001) does not apply
-- to the role that owns the table: PostgreSQL exempts owners, and superusers,
-- from RLS. That exemption is the single easiest way to silently lose tenant
-- isolation in production — point the application's DATABASE_URL at the same
-- admin/owner connection the migrations use (an easy mistake, and one that
-- looks like it is working perfectly) and every policy in 0001 stops applying,
-- with no error and no log line.
--
-- FORCE closes that: the policies apply to the owner too, so a
-- misconfiguration fails loudly instead of leaking across tenants.
--
-- Safe for the tooling that legitimately connects as the owner: migrations
-- only run DDL, and TRUNCATE (used to reset test databases) is not subject to
-- RLS. Application DML always goes through the mm_app role, which was never
-- exempt.
--
-- See docs/security.md §2.

ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods FORCE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates FORCE ROW LEVEL SECURITY;
ALTER TABLE tax_codes FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE dimensions FORCE ROW LEVEL SECURITY;
ALTER TABLE dimension_values FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_line_dimensions FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
