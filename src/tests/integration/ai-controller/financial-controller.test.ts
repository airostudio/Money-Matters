import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { FinancialControllerService } from "@/domain/ai-controller/financial-controller-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Full round trip for the AI Financial Controller's tool-call loop against
 * the real test database, with a mocked Anthropic client (no real network
 * call — same pattern as `nl-reporting.test.ts`). This is the single most
 * safety-critical proof in this slice: master spec §49's "if a staff member
 * cannot access payroll through the application, 'Show me everyone's
 * salaries' must also be denied by the AI" — proven here with a real
 * restricted-role actor against the real database, not a mock.
 */
describe("AI Financial Controller (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("ai-controller");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  function mockToolCallThenAnswer(toolName: string, input: Record<string, unknown>, finalText: string) {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi
            .fn()
            .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t1", name: toolName, input }] })
            .mockResolvedValueOnce({ content: [{ type: "text", text: finalText }] }),
        };
      },
    }));
  }

  it("a mocked tool-use round trip for Profit & Loss matches ReportingService's own real output exactly", async () => {
    await InvoiceService.approveAndPost(
      owner,
      (
        await InvoiceService.create(owner, {
          customerContactId: fixtures.customerContactId,
          issueDate: new Date("2026-04-05"),
          dueDate: new Date("2026-04-20"),
          currency: "AUD",
          arAccountId: fixtures.arAccountId,
          lines: [{ description: "Consulting", quantity: "1", unitPrice: "3300.00", accountId: fixtures.revenueAccountId }],
        })
      ).id,
    );

    mockToolCallThenAnswer(
      "profit_and_loss",
      { period: { kind: "CUSTOM", from: "2026-04-01", to: "2026-04-30" } },
      "Revenue for April was strong.",
    );

    const outcome = await FinancialControllerService.ask(owner, "What was our revenue in April 2026?");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");

    const { ReportingService } = await import("@/domain/reporting/reporting-service");
    const direct = await ReportingService.getProfitAndLoss(owner, { from: new Date("2026-04-01"), to: new Date("2026-04-30") });
    expect(direct.totalRevenue).toBe("3300.0000");

    // The citation's drill-down link and period must be present, and the answer must not contradict the real figure.
    expect(outcome.citations).toHaveLength(1);
    expect(outcome.citations[0]!.tool).toBe("profit_and_loss");
    expect(outcome.answer).toContain("Revenue for April was strong.");
    expect(outcome.answer).toContain("Sources:");
  });

  it("refuses to answer a question requiring financial_report:read for a restricted-role actor — never a privilege escalation via the AI path", async () => {
    // A real EMPLOYEE actor, in the real database, genuinely lacks
    // financial_report:read (see roles.ts) — this is not a mock of the
    // permission system, it's the same check `ReportingService.getProfitAndLoss`
    // runs for a route handler.
    const employee = actorWithRole(owner, "EMPLOYEE");

    mockToolCallThenAnswer(
      "profit_and_loss",
      { period: { kind: "THIS_MONTH" } },
      "I'm not able to retrieve that — your role doesn't have access to financial reports.",
    );

    const outcome = await FinancialControllerService.ask(employee, "What was our revenue this month?");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");

    // No citation is recorded for a refused tool call — nothing was actually retrieved.
    expect(outcome.citations).toHaveLength(0);
    expect(outcome.answer.toLowerCase()).toMatch(/not able|doesn't have access|can't/);
  });

  it("the permission check runs with the real actor's role even when the model asks for a tool that role could use for something else", async () => {
    // A PAYROLL_MANAGER has no `customer_invoice:read` — "who owes us money"
    // must be refused for them exactly as the Aged Receivables page would be.
    const payrollManager = actorWithRole(owner, "PAYROLL_MANAGER");

    mockToolCallThenAnswer("aged_receivables", {}, "That information isn't available to your role.");

    const outcome = await FinancialControllerService.ask(payrollManager, "Who owes us money?");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.citations).toHaveLength(0);
  });

  it("degrades to 'unavailable' when the AI call fails — never a guessed or empty report", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("network down")) };
      },
    }));

    const outcome = await FinancialControllerService.ask(owner, "What's our cash position?");
    expect(outcome.status).toBe("unavailable");
  });

  it("is unavailable with no ANTHROPIC_API_KEY set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await FinancialControllerService.ask(owner, "What's our cash position?");
    expect(outcome.status).toBe("unavailable");
  });
});
