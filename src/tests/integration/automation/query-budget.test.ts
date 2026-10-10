import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { instrumentTenant, tracker } from "../../helpers/connection-tracker";

vi.mock("@/db/tenant", async (importOriginal) => instrumentTenant(await importOriginal<typeof import("@/db/tenant")>()));

import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { enableWebhookEncryption, fakeResolver, fakeTransport } from "../../helpers/webhooks";
import { makeRule, passDeps } from "../../helpers/automation";
import { AutomationEngine } from "@/domain/automation/engine";
import { AutomationRuleService } from "@/domain/automation/rule-service";
import { IntegrationService } from "@/domain/integrations/connection-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * The DATABASE BUDGET of the Automation Centre (docs/architecture.md section 13). Counted at the driver (every statement,
 * including BEGIN / set_config / COMMIT) with the real engine and database. The Supabase session pooler caps the whole
 * project at ~15 clients and DATABASE_POOL_MAX defaults to 3, so a pass must cost a small number of SEQUENTIAL statements,
 * never hold two connections, and never grow with the number of events it looks at.
 */
describe("automation database budget", () => {
  afterAll(closeTestPools);

  let owner: Actor;
  let orgId: string;
  let currency: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let statements: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDatabase();
    enableWebhookEncryption();
    const org = await createTestOrg("auto-budget");
    owner = org.owner;
    orgId = org.organizationId;
    currency = org.baseCurrency;
    sales = await createSalesFixtures(owner, currency);
    spy?.mockRestore();
    const original = pg.Client.prototype.query;
    spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      statements.push(typeof first === "string" ? first : (first?.text ?? ""));
      return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
  });
  afterAll(() => spy?.mockRestore());

  const invoice = () =>
    InvoiceService.create(owner, { customerContactId: sales.customerContactId, issueDate: new Date("2026-01-01"), dueDate: new Date("2026-01-31"), currency, arAccountId: sales.arAccountId, lines: [{ description: "x", quantity: "1", unitPrice: "10.00", accountId: sales.revenueAccountId }] });

  async function measure(run: () => Promise<unknown>) {
    statements = [];
    tracker.reset();
    await run();
    return { statements: statements.length, transactions: tracker.tenantCalls.length, maxActive: tracker.maxActive, sql: [...statements] };
  }
  const pass = (deps = passDeps()) => AutomationEngine.runPass(orgId, { source: "MANUAL" }, deps);
  const log = (label: string, m: { statements: number; transactions: number }) => console.log(`[automation budget] ${label}: ${m.statements} statements in ${m.transactions} transaction(s)`);

  it("an idle pass (no rules) is ONE transaction and a handful of statements; an archived/paused org costs the same one statement of work", async () => {
    const m = await measure(() => pass());
    log("idle pass, no rules", m);
    expect(m.transactions).toBe(1);
    expect(m.maxActive).toBe(1);
    expect(m.statements).toBeLessThanOrEqual(6);
  });

  it("the planning cost does NOT grow with the number of pending events (events are read in ONE statement) or non-matching rules", async () => {
    await makeRule(owner, { name: "never matches", conditions: [{ field: "total", operator: "gt", value: "999999" }] });
    await new Promise((r) => setTimeout(r, 10));
    await pass(); // warm-up: the once-an-hour retention sweep runs in the first pass of a process
    await invoice();
    const one = await measure(() => pass());
    for (let i = 0; i < 15; i += 1) await invoice();
    const sixteen = await measure(() => pass());
    log("pass, 1 rule, 1 event (no match)", one);
    log("pass, 1 rule, 15 events (no match)", sixteen);
    expect(sixteen.transactions).toBe(1);
    expect(sixteen.statements).toBe(one.statements);
    // Adding rules grows the plan by a fixed amount per SCAN rule only; event rules share the event read.
    for (let i = 0; i < 5; i += 1) await makeRule(owner, { name: `r${i}`, conditions: [{ field: "total", operator: "gt", value: "999999" }] });
    await new Promise((r) => setTimeout(r, 10));
    await invoice();
    const six = await measure(() => pass());
    log("pass, 6 event rules, 1 event (no match)", six);
    expect(six.statements).toBe(one.statements);
  });

  it("a successful in-app notification run costs a FIXED number of statements in ONE transaction, however many people are notified", async () => {
    const rule = await makeRule(owner, { name: "n" });
    await new Promise((r) => setTimeout(r, 10));
    await pass(); // warm-up (retention sweep)
    await invoice();
    const one = await measure(() => pass());
    log("pass with 1 event, 1 notify rule, 1 recipient (plan + 1 run)", one);
    expect(one.maxActive).toBe(1);
    expect(one.transactions).toBe(2); // the plan, then ONE transaction for the run

    await addTestMember(owner, "ACCOUNTANT", "A");
    await addTestMember(owner, "BOOKKEEPER", "B");
    await addTestMember(owner, "MANAGER", "M");
    await AutomationRuleService.update(owner, rule, { name: "n", trigger: "invoice.created", action: { type: "NOTIFY_IN_APP", roles: ["OWNER", "ACCOUNTANT", "BOOKKEEPER", "MANAGER"], userIds: [], severity: "INFO" } });
    await new Promise((r) => setTimeout(r, 10));
    await invoice();
    const four = await measure(() => pass());
    log("pass with 1 event, 1 notify rule, 4 recipients", four);
    expect(four.transactions).toBe(2);
    expect(four.statements).toBe(one.statements);
  });

  it("a scan costs one SELECT per scan rule plus the claim; a re-run finds nothing and costs the same plan", async () => {
    await makeRule(owner, { name: "overdue", trigger: "INVOICE_OVERDUE", triggerParams: { days: 1 } });
    const idle = await measure(() => pass(passDeps({ now: () => new Date("2026-03-01T00:00:00Z") })));
    log("pass, 1 overdue-scan rule, nothing overdue", idle);
    expect(idle.transactions).toBe(1);
    const scans = idle.sql.filter((s) => /from invoices i/i.test(s));
    expect(scans).toHaveLength(1);
    await makeRule(owner, { name: "due", trigger: "BILL_DUE_SOON", triggerParams: { days: 7 } });
    await makeRule(owner, { name: "reorder", trigger: "INVENTORY_BELOW_REORDER" });
    const three = await measure(() => pass(passDeps({ now: () => new Date("2026-03-01T00:00:00Z") })));
    log("pass, 3 scan rules, nothing to do", three);
    expect(three.transactions).toBe(1);
    expect(three.statements).toBeGreaterThan(idle.statements);
    expect(three.statements - idle.statements).toBeLessThanOrEqual(6); // 2 more scans (+ the reorder re-arm), bounded and fixed
  });

  it("a run with a channel send is exactly THREE transactions (plan, read the send plan, record) and never two connections", async () => {
    const summary = await IntegrationService.create(owner, { providerId: "slack_incoming_webhook", name: "c", config: { webhookUrl: "https://hooks.slack.com/services/T1/B1/xyzxyzxyzxyz" } }, { resolver: fakeResolver() });
    await makeRule(owner, { name: "send", action: { type: "SEND_TO_CHANNEL", connectionId: summary.id } });
    await new Promise((r) => setTimeout(r, 10));
    await invoice();
    const transport = fakeTransport();
    const m = await measure(() => pass(passDeps({ transport })));
    log("pass with 1 event and 1 channel send (plan + read + record)", m);
    expect(transport.calls).toHaveLength(1);
    expect(m.transactions).toBe(3);
    expect(m.maxActive).toBe(1);
  });

  it("a paused or archived-like early exit costs ONE statement of work (the head query) and opens one transaction", async () => {
    await AutomationRuleService.setAllPaused(owner, true);
    const m = await measure(() => pass());
    log("pass while paused", m);
    expect(m.transactions).toBe(1);
    expect(m.statements).toBeLessThanOrEqual(4); // BEGIN, set_config, the head SELECT, COMMIT
  });
});
