import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { auditLogs, domainEvents } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { closeTestPools, addTestMember, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { enableWebhookEncryption, disableWebhookEncryption, eventsOf, fakeResolver, fakeTransport, makeSubscription } from "../../helpers/webhooks";
import { jobsOf, makeRule, notificationsOf, passDeps, ruleInput, ruleRow, runsOf } from "../../helpers/automation";
import { AutomationEngine } from "@/domain/automation/engine";
import { AutomationRuleService, InvalidRuleError } from "@/domain/automation/rule-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { BillService } from "@/domain/purchases/bill-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { OrganizationLifecycleService } from "@/domain/organizations/lifecycle-service";
import { NotificationService } from "@/domain/notifications/notification-service";
import { WebhookDispatchService } from "@/domain/webhooks/dispatch-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { EVENT_TRIGGERS } from "@/domain/automation/vocabulary";
import { db } from "@/db/client";

/**
 * The evaluation pass against the real test database (docs/architecture.md section 13): every event trigger fires its rule
 * exactly once, conditions gate, recipients are filtered, loops are impossible, and every safety rail holds.
 */
describe("automation engine: event-driven rules", () => {
  afterAll(closeTestPools);

  let owner: Actor;
  let orgId: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    disableWebhookEncryption();
    const org = await createTestOrg("auto-events");
    owner = org.owner;
    orgId = org.organizationId;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    purchases = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  const invoiceInput = (unitPrice = "100.00", quantity = "10") => ({
    customerContactId: sales.customerContactId,
    issueDate: new Date("2026-01-01"),
    dueDate: new Date("2026-01-31"),
    currency: "AUD",
    arAccountId: sales.arAccountId,
    lines: [{ description: "Consulting", quantity, unitPrice, accountId: sales.revenueAccountId, taxCodeId: sales.taxCodeId }],
  });
  const billInput = () => ({
    supplierContactId: purchases.supplierContactId,
    issueDate: new Date("2026-01-01"),
    dueDate: new Date("2026-01-31"),
    currency: "AUD",
    apAccountId: purchases.apAccountId,
    lines: [{ description: "Paper", quantity: "2", unitPrice: "50.00", accountId: purchases.expenseAccountId, taxCodeId: purchases.taxCodeId }],
  });
  const pass = (deps = passDeps()) => AutomationEngine.runPass(orgId, { source: "MANUAL" }, deps);
  const notify = (roles: string[] = ["OWNER"]) => ({ type: "NOTIFY_IN_APP" as const, roles, userIds: [] as string[], severity: "INFO" as const, includeAmounts: false });

  it("every event trigger fires its own rule exactly once, and a re-run never duplicates", async () => {
    const ruleIds = new Map<string, string>();
    for (const trigger of EVENT_TRIGGERS) ruleIds.set(trigger, await makeRule(owner, { name: `on ${trigger}`, trigger, action: notify() }));

    const created = await InvoiceService.create(owner, invoiceInput());
    await InvoiceService.approveAndPost(owner, created.id);
    await InvoiceService.markSent(owner, created.id);
    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: sales.customerContactId,
      paymentDate: new Date("2026-01-15"),
      amount: "1100.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: sales.bankGlAccountId,
      allocations: [{ invoiceId: created.id, amount: "1100.00" }],
    });
    const bill = await BillService.create(owner, billInput());
    await BillService.approveAndPost(owner, bill.id);
    await ContactService.create(owner, { kind: "CUSTOMER", displayName: "New customer", currency: "AUD" });
    await ContactService.create(owner, { kind: "SUPPLIER", displayName: "New supplier", currency: "AUD" });

    const first = await pass();
    expect(first.skipped).toBeNull();
    expect(first.failed).toBe(0);
    for (const [trigger, id] of ruleIds) {
      const runs = await runsOf(orgId, id);
      expect(runs.map((r) => r.outcome), trigger).toEqual(["SUCCESS"]);
    }
    const jobCount = (await jobsOf(orgId)).length;
    const notificationCount = (await notificationsOf(orgId)).length;
    expect(jobCount).toBe(EVENT_TRIGGERS.length);

    // Run it again, several times: nothing new.
    for (let i = 0; i < 3; i += 1) await pass();
    expect((await jobsOf(orgId)).length).toBe(jobCount);
    expect((await runsOf(orgId)).length).toBe(jobCount);
    expect((await notificationsOf(orgId)).length).toBe(notificationCount);
    // Every event from after the rules existed was marked as seen (older ones can never fire anything and are simply never read).
    const firstRule = Math.min(...(await Promise.all([...ruleIds.values()].map((id) => ruleRow(orgId, id)))).map((r) => r.createdAt.getTime()));
    const unseen = (await eventsOf(orgId)).filter((e) => e.automationProcessedAt === null && e.occurredAt.getTime() >= firstRule);
    expect(unseen.map((e) => e.type)).toEqual([]);
  });

  it("conditions gate with exact decimals: total > 1000 fires for 1100.00 but not for 110.00, and 'at least 1100' includes equality", async () => {
    const big = await makeRule(owner, { name: "big", conditions: [{ field: "total", operator: "gt", value: "1000" }] });
    const exact = await makeRule(owner, { name: "exact", conditions: [{ field: "total", operator: "gte", value: "1100.00" }] });
    const above = await makeRule(owner, { name: "above", conditions: [{ field: "total", operator: "gt", value: "1100.00" }] });
    const small = await InvoiceService.create(owner, invoiceInput("10.00", "10")); // 100 + GST 10 = 110.00
    const large = await InvoiceService.create(owner, invoiceInput("100.00", "10")); // 1000 + GST 100 = 1100.00
    await pass();
    const runsFor = async (ruleId: string) => (await runsOf(orgId, ruleId)).map((r) => r.jobKey);
    expect((await runsFor(big)).length).toBe(1);
    expect((await runsFor(exact)).length).toBe(1);
    expect((await runsFor(above)).length).toBe(0);
    const bigEvents = (await eventsOf(orgId, "invoice.created")).filter((e) => e.aggregateId === large.id);
    expect(await runsFor(big)).toEqual([`event:${bigEvents[0]!.id}`]);
    void small;
  });

  it("a rule only reacts to events from after it was created", async () => {
    await InvoiceService.create(owner, invoiceInput()); // before the rule exists
    await new Promise((r) => setTimeout(r, 15));
    const rule = await makeRule(owner);
    await new Promise((r) => setTimeout(r, 15));
    await pass();
    expect(await runsOf(orgId, rule)).toHaveLength(0);
    await InvoiceService.create(owner, invoiceInput());
    await pass();
    expect(await runsOf(orgId, rule)).toHaveLength(1);
  });

  describe("NOTIFY_IN_APP", () => {
    it("notifies only active members whose role can see the object, each person sees only their own, and folds repeats", async () => {
      const accountant = await addTestMember(owner, "ACCOUNTANT", "Accountant");
      const readOnly = await addTestMember(owner, "READ_ONLY", "Viewer");
      const employee = await addTestMember(owner, "EMPLOYEE", "Employee"); // cannot read invoices
      const named = await addTestMember(owner, "BOOKKEEPER", "Named");
      await makeRule(owner, { action: { type: "NOTIFY_IN_APP", roles: ["ACCOUNTANT", "READ_ONLY", "EMPLOYEE"], userIds: [named.userId], severity: "ACTION", includeAmounts: false } });
      await InvoiceService.create(owner, invoiceInput());
      await pass();

      expect(await notificationsOf(orgId, accountant.userId)).toHaveLength(1);
      expect(await notificationsOf(orgId, readOnly.userId)).toHaveLength(1);
      expect(await notificationsOf(orgId, named.userId)).toHaveLength(1);
      expect(await notificationsOf(orgId, employee.userId)).toHaveLength(0); // role cannot read invoices
      expect(await notificationsOf(orgId, owner.userId)).toHaveLength(0); // not in the audience
      // Each person reads only their own through the service.
      const mine = await NotificationService.list(accountant);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ title: "Test rule", severity: "ACTION", source: "automation" });
      expect(mine[0]!.link).toMatch(/^\/auto-events-\d+-\d+\/sales\/invoices\//);
      expect(await NotificationService.list(owner)).toHaveLength(0);
      // Minimal content by default: no amounts.
      expect(JSON.stringify(mine)).not.toMatch(/1100|Total/);
    });

    it("includes amounts only when the rule opts in", async () => {
      await makeRule(owner, { action: { ...notify(), includeAmounts: true } });
      await InvoiceService.create(owner, invoiceInput());
      await pass();
      const mine = await NotificationService.list(owner);
      expect(mine[0]!.body).toMatch(/Total 1100\.00 AUD/);
    });

    it("never notifies a suspended or removed member, and records SKIPPED when nobody is eligible", async () => {
      const gone = await addTestMember(owner, "ACCOUNTANT", "Leaver");
      const members = await OrganizationService.listMembers(owner);
      await OrganizationService.removeMember(owner, members.find((m) => m.userId === gone.userId)!.membershipId);
      const rule = await makeRule(owner, { action: notify(["ACCOUNTANT"]) });
      await InvoiceService.create(owner, invoiceInput());
      await pass();
      expect(await notificationsOf(orgId, gone.userId)).toHaveLength(0);
      const runs = await runsOf(orgId, rule);
      expect(runs.map((r) => r.outcome)).toEqual(["SKIPPED"]);
      expect(runs[0]!.reason).toMatch(/No eligible recipients/);
    });
  });

  describe("EMIT_WEBHOOK_EVENT and loop protection", () => {
    it("emits one automation.triggered event carrying the API DTO only, delivered through the webhook path; it never re-triggers a rule", async () => {
      enableWebhookEncryption();
      await makeSubscription(owner, { eventTypes: ["automation.triggered"], url: "https://hooks.example.com/auto" });
      const rule = await makeRule(owner, { name: "Emit on invoice", action: { type: "EMIT_WEBHOOK_EVENT" } });
      // A second rule on the same trigger that would fire again if it ever saw the automation's own event.
      const bystander = await makeRule(owner, { name: "Bystander", action: notify() });
      const invoice = await InvoiceService.create(owner, invoiceInput());

      await pass();
      const emitted = await eventsOf(orgId, "automation.triggered");
      expect(emitted).toHaveLength(1);
      const event = emitted[0]!;
      expect(event.origin).toBe("automation");
      expect(event.automationProcessedAt).not.toBeNull(); // pre-marked: never read by the evaluator
      const envelope = event.payload as { data: { object: { rule: { id: string; name: string }; trigger: string; subject: { type: string; id: string }; object: Record<string, unknown> } } };
      expect(envelope.data.object.rule).toEqual({ id: rule, name: "Emit on invoice" });
      expect(envelope.data.object.trigger).toBe("invoice.created");
      expect(envelope.data.object.subject).toEqual({ type: "Invoice", id: invoice.id });
      expect(envelope.data.object.object.id).toBe(invoice.id);
      expect(JSON.stringify(envelope)).not.toMatch(/organization_id|organizationId|created_by|createdBy/);

      // Further passes: the automation event does not trigger anything (still ONE emitted event, ONE bystander run).
      for (let i = 0; i < 3; i += 1) await pass();
      expect(await eventsOf(orgId, "automation.triggered")).toHaveLength(1);
      expect(await runsOf(orgId, bystander)).toHaveLength(1);
      expect(await runsOf(orgId, rule)).toHaveLength(1);

      // It is delivered via the existing webhook subscription, with the signature machinery, to the fake HTTP client.
      const transport = fakeTransport();
      const result = await WebhookDispatchService.dispatch(orgId, { limit: 10 }, { resolver: fakeResolver(), transport, random: () => 0.5 });
      expect(result.delivered).toBeGreaterThanOrEqual(1);
      const delivered = transport.calls.filter((c) => c.headers["Mm-Event-Type"] === "automation.triggered");
      expect(delivered).toHaveLength(1);
      expect(JSON.parse(delivered[0]!.body).data.object.rule.id).toBe(rule);
    });

    it("an event row with origin=automation is never read, even if its processed flag were somehow clear", async () => {
      const rule = await makeRule(owner, { action: notify() });
      const invoice = await InvoiceService.create(owner, invoiceInput());
      void invoice;
      // Forge: flip the legitimate event's origin and clear nothing else.
      const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await admin.query(`UPDATE domain_events SET origin = 'automation' WHERE type = 'invoice.created'`);
      } finally {
        await admin.end();
      }
      await pass();
      expect(await runsOf(orgId, rule)).toHaveLength(0);
    });

    it("a stored rule whose trigger is automation.triggered is refused at creation and switched off if forged", async () => {
      await expect(AutomationRuleService.create(owner, ruleInput({ trigger: "automation.triggered" }))).rejects.toBeInstanceOf(InvalidRuleError);
      const id = await makeRule(owner);
      const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await admin.query(`UPDATE automation_rules SET trigger = 'automation.triggered' WHERE id = $1`, [id]);
      } finally {
        await admin.end();
      }
      await InvoiceService.create(owner, invoiceInput());
      const result = await pass();
      expect(result.rulesDisabled).toBe(1);
      const row = await ruleRow(orgId, id);
      expect(row).toMatchObject({ enabled: false, disabledCode: "INVALID_RULE" });
      expect(await runsOf(orgId, id)).toHaveLength(0);
    });
  });

  describe("pause, archive, authoriser changes", () => {
    it("'Pause all' takes effect on the very next pass; events from the paused period never fire after resume", async () => {
      const rule = await makeRule(owner);
      await InvoiceService.create(owner, invoiceInput());
      expect((await pass()).succeeded).toBe(1);

      await AutomationRuleService.setAllPaused(owner, true);
      await InvoiceService.create(owner, invoiceInput());
      const paused = await pass();
      expect(paused.skipped).toBe("paused");
      expect(await runsOf(orgId, rule)).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 20));
      await AutomationRuleService.setAllPaused(owner, false);
      await pass();
      expect(await runsOf(orgId, rule)).toHaveLength(1); // the event from the paused period is not replayed
      await InvoiceService.create(owner, invoiceInput());
      await pass();
      expect(await runsOf(orgId, rule)).toHaveLength(2);
      const actions = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(["automation.all_paused", "automation.all_resumed"]));
    });

    it("a paused rule does not run; enabling it again is a fresh approval and clears the failure state", async () => {
      const rule = await makeRule(owner);
      await AutomationRuleService.setEnabled(owner, rule, false);
      await InvoiceService.create(owner, invoiceInput());
      await pass();
      expect(await runsOf(orgId, rule)).toHaveLength(0);
      const row = await ruleRow(orgId, rule);
      expect(row).toMatchObject({ enabled: false, disabledCode: "USER_PAUSED" });
      await AutomationRuleService.setEnabled(owner, rule, true);
      expect(await ruleRow(orgId, rule)).toMatchObject({ enabled: true, disabledCode: null, consecutiveFailures: 0 });
    });

    it("an archived organization runs nothing and its events stay pending; they flow after a restore", async () => {
      const rule = await makeRule(owner);
      await InvoiceService.create(owner, invoiceInput());
      await OrganizationLifecycleService.archive(owner, { confirmName: (await db.query.organizations.findFirst({ where: (o, { eq: e }) => e(o.id, orgId) }))!.name, acknowledged: true, reason: "Closing for the season" });
      const result = await pass();
      expect(result.skipped).toBe("archived");
      expect(await runsOf(orgId, rule)).toHaveLength(0);
      const pending = (await eventsOf(orgId, "invoice.created")).filter((e) => e.automationProcessedAt === null);
      expect(pending).toHaveLength(1);

      await OrganizationLifecycleService.restore(owner.userId, orgId);
      await pass();
      expect(await runsOf(orgId, rule)).toHaveLength(1);
    });

    async function authorisedByAdmin() {
      const admin = await addTestMember(owner, "ADMINISTRATOR", "Admin");
      const id = await makeRule(admin, { name: "Admin's rule" });
      return { admin, id };
    }

    it("the authoriser being REMOVED stops the rule at the next pass, visibly, without deleting it", async () => {
      const { admin, id } = await authorisedByAdmin();
      const members = await OrganizationService.listMembers(owner);
      await OrganizationService.removeMember(owner, members.find((m) => m.userId === admin.userId)!.membershipId);
      await InvoiceService.create(owner, invoiceInput());
      const result = await pass();
      expect(result.rulesDisabled).toBe(1);
      expect(await runsOf(orgId, id)).toHaveLength(0);
      const row = await ruleRow(orgId, id);
      expect(row).toMatchObject({ enabled: false, disabledCode: "AUTHORISER_INACTIVE" });
      expect(row.disabledReason).toMatch(/no longer an active member/);
      const audit = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).filter((a) => a.action === "automation_rule.disabled_by_system");
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorType).toBe("SYSTEM");
    });

    it("the authoriser being SUSPENDED stops the rule", async () => {
      const { admin, id } = await authorisedByAdmin();
      const adminPool = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await adminPool.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [admin.userId]);
      } finally {
        await adminPool.end();
      }
      await InvoiceService.create(owner, invoiceInput());
      await pass();
      expect(await ruleRow(orgId, id)).toMatchObject({ enabled: false, disabledCode: "AUTHORISER_INACTIVE" });
      expect(await runsOf(orgId, id)).toHaveLength(0);
    });

    it("the authoriser being DEMOTED below automation:manage stops the rule immediately", async () => {
      const { admin, id } = await authorisedByAdmin();
      const members = await OrganizationService.listMembers(owner);
      await OrganizationService.updateMemberRole(owner, members.find((m) => m.userId === admin.userId)!.membershipId, "ACCOUNTANT");
      await InvoiceService.create(owner, invoiceInput());
      await pass();
      expect(await ruleRow(orgId, id)).toMatchObject({ enabled: false, disabledCode: "AUTHORISER_LACKS_PERMISSION" });
      expect(await runsOf(orgId, id)).toHaveLength(0);
    });

    it("the page can show the problem BEFORE the next run, and a different human re-enabling takes over as the authoriser", async () => {
      const { admin, id } = await authorisedByAdmin();
      const members = await OrganizationService.listMembers(owner);
      await OrganizationService.removeMember(owner, members.find((m) => m.userId === admin.userId)!.membershipId);
      const view = (await AutomationRuleService.list(owner)).find((r) => r.id === id)!;
      expect(view.enabled).toBe(true);
      expect(view.authoriserOk).toBe(false);
      expect(view.authoriserProblem).toMatch(/Will be switched off at the next run/);
      await pass();
      await AutomationRuleService.setEnabled(owner, id, true);
      const row = await ruleRow(orgId, id);
      expect(row).toMatchObject({ enabled: true, authorisedByUserId: owner.userId, createdByUserId: admin.userId });
      await InvoiceService.create(owner, invoiceInput());
      await pass();
      expect(await runsOf(orgId, id)).toHaveLength(1);
    });

    it("a tampered stored rule (unknown field) is re-validated on the run and switched off, never executed", async () => {
      const rule = await makeRule(owner, { conditions: [{ field: "total", operator: "gt", value: "1" }] });
      const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await admin.query(`UPDATE automation_rules SET conditions = '[{"field":"1=1; DROP TABLE invoices","operator":"gt","value":"1"}]'::jsonb WHERE id = $1`, [rule]);
        await InvoiceService.create(owner, invoiceInput());
        const result = await pass();
        expect(result.rulesDisabled).toBe(1);
        expect(await ruleRow(orgId, rule)).toMatchObject({ enabled: false, disabledCode: "INVALID_RULE" });
        expect(await runsOf(orgId, rule)).toHaveLength(0);
        const check = await admin.query(`SELECT count(*)::int AS n FROM invoices`);
        expect(check.rows[0].n).toBe(1);
      } finally {
        await admin.end();
      }
    });
  });

  describe("management is human-only", () => {
    it("a non-owner role, an API actor, an AI actor and an AUTOMATION actor cannot create, enable, delete or pause", async () => {
      const accountant = await addTestMember(owner, "ACCOUNTANT", "Accountant");
      const rule = await makeRule(owner);
      for (const actor of [accountant, { ...owner, type: "API" as const }, { ...owner, type: "AI" as const }, { ...owner, type: "AUTOMATION" as const }, { ...owner, type: "SYSTEM" as const }]) {
        await expect(AutomationRuleService.create(actor, ruleInput())).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(AutomationRuleService.setEnabled(actor, rule, false)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(AutomationRuleService.remove(actor, rule)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(AutomationRuleService.setAllPaused(actor, true)).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(AutomationEngine.runNow(actor)).rejects.toBeInstanceOf(PermissionDeniedError);
      }
      // ...but the accountant can LOOK.
      expect((await AutomationRuleService.list(accountant)).map((r) => r.id)).toEqual([rule]);
    });
  });

  describe("caps", () => {
    it("at most 10 runs per rule per pass; the rest wait for the next pass and nothing is lost or duplicated", async () => {
      const rule = await makeRule(owner);
      for (let i = 0; i < 13; i += 1) await InvoiceService.create(owner, invoiceInput());
      const first = await pass();
      expect(first.capped).toBe(true);
      expect(await runsOf(orgId, rule)).toHaveLength(10);
      const second = await pass();
      expect(second.capped).toBe(false);
      expect(await runsOf(orgId, rule)).toHaveLength(13);
      expect(new Set((await jobsOf(orgId, rule)).map((j) => j.jobKey)).size).toBe(13);
    });

    it("a rule that has used its daily allowance records SKIPPED instead of running, and the event is not stuck", async () => {
      const rule = await makeRule(owner);
      const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
      try {
        await admin.query(
          `INSERT INTO automation_jobs (organization_id, rule_id, job_key, state, context) SELECT $1, $2, 'filler:' || g, 'DONE', '{}'::jsonb FROM generate_series(1, 100) g`,
          [orgId, rule],
        );
      } finally {
        await admin.end();
      }
      await InvoiceService.create(owner, invoiceInput());
      const result = await pass();
      expect(result.capped).toBe(true);
      const runs = await runsOf(orgId, rule);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "SKIPPED" });
      expect(runs[0]!.reason).toMatch(/Daily limit/);
      expect(await notificationsOf(orgId)).toHaveLength(0);
      expect((await eventsOf(orgId, "invoice.created")).every((e) => e.automationProcessedAt !== null)).toBe(true);
    });
  });

  it("the run log and every audit row record the AUTOMATION actor, the rule and its authoriser", async () => {
    const rule = await makeRule(owner, { name: "Audit me" });
    await InvoiceService.create(owner, invoiceInput());
    await pass();
    const runs = await runsOf(orgId, rule);
    expect(runs[0]).toMatchObject({ outcome: "SUCCESS", actorType: "AUTOMATION", actorUserId: owner.userId, ruleName: "Audit me", source: "MANUAL", attempt: 1 });
    const audit = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).filter((a) => a.action === "automation.run.success");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: "AUTOMATION", actorUserId: owner.userId, entityId: rule });
    expect(audit[0]!.metadata).toMatchObject({ viaAutomation: true, automationRuleId: rule, automationRuleName: "Audit me", automationAuthorisedBy: owner.userId });
    // The creation itself was a HUMAN action.
    const created = (await withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, orgId)))).filter((a) => a.action === "automation_rule.created");
    expect(created[0]).toMatchObject({ actorType: "HUMAN", actorUserId: owner.userId });
    void domainEvents;
  });
});
