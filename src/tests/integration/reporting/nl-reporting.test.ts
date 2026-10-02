import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSampleAccounts } from "../../helpers/ledger";
import { PostingService } from "@/domain/ledger/posting-service";
import { DimensionService } from "@/domain/dimensions/dimension-service";
import { ReportBuilderService } from "@/domain/reporting/report-builder-service";
import { NLReportingService } from "@/domain/reporting/nl-reporting-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Full round trip for master spec §34's pipeline: a mocked AI tool-use
 * response → zod-validated structured request → deterministic resolution →
 * the exact same `ReportBuilderService.runConfig` engine the Report Builder
 * UI uses. No real network call is made — `@anthropic-ai/sdk` is mocked,
 * the same pattern `chart-of-accounts-recommender.test.ts` uses for its own
 * AI path.
 */
describe("NL Reporting (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let bankId: string;
  let revenueId: string;
  let currency: string;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("nl-reporting");
    owner = org.owner;
    currency = org.baseCurrency;
    const ids = await createSampleAccounts(owner, currency);
    bankId = ids[0]!;
    revenueId = ids[4]!;
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";

    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-15"),
      lines: [
        { accountId: bankId!, debit: "2500.00", currency },
        { accountId: revenueId!, credit: "2500.00", currency },
      ],
    });
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  function mockAiToolUse(input: Record<string, unknown>) {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "tool_use", name: "structure_report_request", input }],
          }),
        };
      },
    }));
  }

  it("a mocked 'what was revenue in January 2026' response produces the same figure as the equivalent manual report-builder query", async () => {
    mockAiToolUse({
      metric: "REVENUE",
      period: { kind: "CUSTOM", from: "2026-01-01", to: "2026-01-31" },
      breakdown: "NONE",
    });

    const outcome = await NLReportingService.ask(owner, "What was our revenue in January 2026?");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");

    const manual = await ReportBuilderService.runConfig(owner, {
      rowGroupBy: "ACCOUNT_TYPE",
      accountTypes: ["REVENUE"],
      measure: "MOVEMENT",
      periodBreakdown: "NONE",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    expect(outcome.result.rows).toEqual(manual.rows);
    expect(outcome.result.rows.find((r) => r.key === "REVENUE")?.values[0]).toBe("2500.0000");
    expect(outcome.restatement).toContain("Revenue");
  });

  it("rejects (clarification, never a guess) a dimensionKey that doesn't match a real dimension", async () => {
    mockAiToolUse({
      metric: "REVENUE",
      period: { kind: "THIS_MONTH" },
      breakdown: "NONE",
      dimensionKey: "Department", // the org has no dimensions at all
    });

    const outcome = await NLReportingService.ask(owner, "Show revenue for the Sales department");
    expect(outcome.status).toBe("clarification_needed");
  });

  it("resolves a real dimension reference end to end", async () => {
    const dimension = await DimensionService.createDimension(owner, { name: "Project" });
    const projectA = await DimensionService.addValue(owner, dimension.id, { label: "Project A" });
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-20"),
      lines: [
        { accountId: bankId!, debit: "600.00", currency },
        { accountId: revenueId!, credit: "600.00", currency, dimensionValueIds: [projectA.id] },
      ],
    });

    mockAiToolUse({
      metric: "REVENUE",
      period: { kind: "CUSTOM", from: "2026-01-01", to: "2026-01-31" },
      breakdown: "NONE",
      dimensionKey: "Project",
      dimensionValue: "Project A",
    });

    const outcome = await NLReportingService.ask(owner, "What was revenue for Project A in January?");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.result.rows.find((r) => r.key === "REVENUE")?.values[0]).toBe("600.0000");
    expect(outcome.restatement).toContain("Project: Project A");
  });

  it("degrades to 'unavailable' (never a wrong/empty report) when the AI call fails", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("network down")) };
      },
    }));

    const outcome = await NLReportingService.ask(owner, "What was our revenue last month?");
    expect(outcome.status).toBe("unavailable");
  });

  it("degrades to 'unavailable' when the tool_use response fails schema validation (a hallucinated field)", async () => {
    mockAiToolUse({ metric: "TOTALLY_MADE_UP_METRIC", period: { kind: "THIS_MONTH" }, breakdown: "NONE" });

    const outcome = await NLReportingService.ask(owner, "What was our revenue?");
    expect(outcome.status).toBe("unavailable");
  });

  it("is unavailable with no ANTHROPIC_API_KEY set, with no error and no guessed report", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const outcome = await NLReportingService.ask(owner, "What was our revenue last month?");
    expect(outcome.status).toBe("unavailable");
  });
});
