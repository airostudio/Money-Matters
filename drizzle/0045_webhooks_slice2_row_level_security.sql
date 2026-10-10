-- Row-Level Security + grants for Phase 10 Slice 2 (webhooks and the durable event outbox).
-- Read docs/security.md section 16 alongside this file. All four tables are ordinary TENANT tables:
-- ENABLE + FORCE row-level security and the single-variable policy keyed on app.current_org_id, exactly like
-- every other slice (src/db/isolation-audit.ts verifies this at build time).
--
-- Grants are deliberately narrow:
--   domain_events               SELECT, INSERT; UPDATE of ONLY dispatched_at; DELETE (the lazy retention purge).
--                               An event's type, aggregate and payload can never be rewritten after the fact.
--   webhook_subscriptions       SELECT, INSERT, UPDATE, DELETE (managed by OWNER/ADMINISTRATOR humans, audited).
--   webhook_deliveries          SELECT, INSERT, UPDATE (state machine); DELETE for the retention purge.
--   webhook_delivery_attempts   SELECT, INSERT ONLY. The attempt log is APPEND-ONLY: there is no UPDATE and no DELETE
--                               grant, so the application role cannot edit or erase a recorded attempt. Aged rows
--                               are removed only as the FK cascade of a retention-purged event (the cascade is
--                               performed by the referential-integrity trigger as the table owner, not by mm_app).

GRANT SELECT, INSERT ON domain_events TO mm_app;
GRANT UPDATE (dispatched_at) ON domain_events TO mm_app;
GRANT DELETE ON domain_events TO mm_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_subscriptions TO mm_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO mm_app;

GRANT SELECT, INSERT ON webhook_delivery_attempts TO mm_app;

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_domain_events ON domain_events
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_subscriptions ON webhook_subscriptions
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_deliveries ON webhook_deliveries
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE webhook_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_webhook_delivery_attempts ON webhook_delivery_attempts
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
