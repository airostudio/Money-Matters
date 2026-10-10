import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { D, seedForecastData } from "../../helpers/forecast-fixtures";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";
import { AGENT_MODES } from "@/domain/ai-controller/specialist-agents";
import { FinancialControllerService } from "@/domain/ai-controller/financial-controller-service";
import { CashForecastService } from "@/domain/forecasting/cash-forecast-service";
import { ForecastCommentaryService, forecastFacts, scenarioFacts } from "@/domain/forecasting/commentary";
import { ScenarioService } from "@/domain/forecasting/scenario-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * The AI integration for Phase 9 Slice 2, against the real test database with
 * a MOCKED Anthropic SDK (no real network call is ever made, as with every AI
 * feature in this codebase): the read-only `cash_forecast` Financial
 * Controller tool, and the optional forecast/scenario commentary.
 */
describe("Cash forecast — AI Financial Controller tool and commentary", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("cash-forecast-ai");
    owner = org.owner;
    await seedForecastData(owner, org.baseCurrency);
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  const tool = () => {
    const def = buildControllerTools([]).find((t) => t.name === "cash_forecast");
    if (!def) throw new Error("cash_forecast not registered");
    return def;
  };

  it("is a read-only, permission-declared tool, offered to the FP&A specialist, and no scenario-creating tool exists", () => {
    expect(tool().permission).toBe("forecast:read");
    expect(AGENT_MODES.FPA.readToolNames).toContain("cash_forecast");
    expect(AGENT_MODES.FPA.writeToolNames).toEqual([]);

    const writeNames = buildWriteTools("anything", "model").map((t) => t.name);
    const allNames = [...buildControllerTools([]).map((t) => t.name), ...writeNames];
    expect(allNames.filter((n) => /scenario/i.test(n))).toEqual([]);
    expect(writeNames.every((n) => n.startsWith("prepare_draft_"))).toBe(true);
  });

  it("returns a real, cited answer that keeps KNOWN and STATISTICAL separate — numbers match CashForecastService exactly", async () => {
    const outcome = await tool().execute(owner, { horizon: "30D", asOfDate: "2026-10-05" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");

    const direct = await CashForecastService.generate(owner, { asOfDate: D("2026-10-05"), horizon: "30D" });
    const text = outcome.summary;

    // Two separately-labelled projections, each with its own real figures.
    expect(text).toContain("KNOWN COMMITMENTS ONLY");
    expect(text).toContain("INCLUDING STATISTICAL PROJECTIONS (ESTIMATES");
    const knownLine = text.split("\n").find((l) => l.startsWith("KNOWN COMMITMENTS ONLY"))!;
    const statLine = text.split("\n").find((l) => l.startsWith("INCLUDING STATISTICAL"))!;
    expect(knownLine).toContain(direct.knownOnly.endBalance); // 3100.0000
    expect(knownLine).toContain(direct.knownOnly.lowPoint.balance); // 2500.0000
    expect(knownLine).not.toContain(direct.withStatistical.endBalance);
    expect(statLine).toContain(direct.withStatistical.endBalance); // -1069.2308
    expect(statLine).not.toContain(direct.knownOnly.endBalance);

    // The "when might we run low on cash?" answer: the low-cash warning with the real date.
    expect(text).toContain("LOW-CASH WARNING");
    expect(text).toContain("2026-10-16");
    // A statistical line is labelled with its basis; an unverified payroll amount says so.
    expect(text).toMatch(/avg 12 days late over 2 settled invoice/);
    expect(text).toContain("due date NOT verified");

    expect(outcome.citation).toMatchObject({ tool: "cash_forecast", description: "Cash Forecast", periodLabel: "30D from 2026-10-05" });
    expect(outcome.citation.drillDownHref).toContain("/forecasting/cash-flow?horizon=30D");
  });

  it("is refused for a role without forecast:read, exactly like the Cash Forecast page would refuse it", async () => {
    for (const role of ["EMPLOYEE", "PAYROLL_MANAGER", "ACCOUNTS_PAYABLE"] as const) {
      const outcome = await tool().execute(actorWithRole(owner, role), { horizon: "30D" });
      expect(outcome.ok, role).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toMatch(/access denied/i);
      expect(outcome.error).toContain("forecast:read");
    }
  });

  it("PAYROLL OMISSION through the AI path: a role without payrun:read gets the forecast with payroll omitted — and is told so", async () => {
    const manager = actorWithRole(owner, "MANAGER");
    const outcome = await tool().execute(manager, { horizon: "30D", asOfDate: "2026-10-05" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected ok");

    for (const secret of ["3084.6154", "915.3846", "480.0000", "PAYG", "Net wages", "Superannuation", "payroll liabilit"]) {
      expect(outcome.summary).not.toContain(secret);
    }
    expect(outcome.summary).toContain("payroll-derived lines are omitted");
    // …while the permitted figures are all still there.
    expect(outcome.summary).toContain("KNOWN COMMITMENTS ONLY");
    expect(outcome.summary).toContain("3100.0000");

    // The owner (who can read pay runs) sees the payroll lines.
    const full = await tool().execute(owner, { horizon: "30D", asOfDate: "2026-10-05" });
    if (!full.ok) throw new Error("expected ok");
    expect(full.summary).toContain("4480.0000"); // payroll liabilities with unverified timing, summarised off-timeline
  });

  it("validates its arguments (bad horizon / bad date) instead of running", async () => {
    const outcome = await tool().execute(owner, { horizon: "5Y" });
    expect(outcome.ok).toBe(false);
    const bad = await tool().execute(owner, { asOfDate: "tomorrow" });
    expect(bad.ok).toBe(false);
  });

  it("end to end with the mocked model: 'when might we run low on cash?' calls cash_forecast and the tool result handed to the model is the real, labelled forecast", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t1", name: "cash_forecast", input: { horizon: "30D", asOfDate: "2026-10-05" } }] })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "On the including-statistical projection, cash may dip below zero around mid-October; the known-only projection stays positive." }],
      });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

    const outcome = await FinancialControllerService.ask(owner, "When might we run low on cash?");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");

    expect(outcome.citations).toHaveLength(1);
    expect(outcome.citations[0]!.tool).toBe("cash_forecast");
    expect(outcome.answer).toContain("Sources:");

    // The first request offered cash_forecast; the second carried its real tool_result.
    const firstTools = (create.mock.calls[0]![0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(firstTools).toContain("cash_forecast");
    const secondMessages = (create.mock.calls[1]![0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    const toolResult = JSON.stringify(secondMessages[secondMessages.length - 1]!.content);
    expect(toolResult).toContain("KNOWN COMMITMENTS ONLY");
    expect(toolResult).toContain("INCLUDING STATISTICAL");
  });

  it("end to end with a restricted role: the controller reports the refusal and records no citation", async () => {
    const employee = actorWithRole(owner, "EMPLOYEE");
    const create = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t1", name: "cash_forecast", input: {} }] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "I can't retrieve that — your role doesn't have access to forecasts." }] });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

    const outcome = await FinancialControllerService.ask(employee, "When might we run low on cash?");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.citations).toHaveLength(0);
    const secondMessages = (create.mock.calls[1]![0] as { messages: Array<{ content: unknown }> }).messages;
    expect(JSON.stringify(secondMessages[secondMessages.length - 1]!.content)).toMatch(/Access denied/);
  });

  describe("optional commentary", () => {
    it("is handed only already-computed figures, with KNOWN and STATISTICAL kept distinct, and returns the model's text", async () => {
      const forecast = await CashForecastService.generate(owner, { asOfDate: D("2026-10-05"), horizon: "30D" });
      const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Cash looks tight in mid-October on the estimated view." }] });
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

      const text = await ForecastCommentaryService.forForecast(forecast);
      expect(text).toBe("Cash looks tight in mid-October on the estimated view.");

      const request = create.mock.calls[0]![0] as { system: string; messages: Array<{ content: string }> };
      expect(request.system).toMatch(/never calculate/i);
      expect(request.system).toMatch(/KNOWN-commitments-only projection and the INCLUDING-statistical projection/);
      const facts = request.messages[0]!.content;
      expect(facts).toContain("KNOWN-COMMITMENTS-ONLY projection");
      expect(facts).toContain("INCLUDING-STATISTICAL projection");
      expect(facts).toContain(forecast.knownOnly.endBalance);
      expect(facts).toContain(forecast.withStatistical.endBalance);
      // Every figure in the facts is one the application computed — nothing the model is asked to derive.
      expect(forecastFacts(forecast).join("\n")).toBe(facts.replace("Here are the already-computed figures:\n\n", ""));
    });

    it("scenario commentary frames cases as assumptions", async () => {
      const result = await ScenarioService.preview(owner, "HIRE_EMPLOYEE", { annualSalary: "90000", onCostPercent: "12", startDate: "2026-11-01" }, { asOfDate: D("2026-10-05"), includeForecastContext: false });
      const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Under these assumptions the hire is a net cost." }] });
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

      expect(await ForecastCommentaryService.forScenario(result)).toBe("Under these assumptions the hire is a net cost.");
      const request = create.mock.calls[0]![0] as { system: string; messages: Array<{ content: string }> };
      expect(request.system).toMatch(/assumptions, never as predictions/);
      expect(request.messages[0]!.content).toContain("WORST case");
      expect(scenarioFacts(result).some((f) => f.includes(result.cases.WORST.summary.twelveMonthNetProfitDelta))).toBe(true);
    });

    it("is omitted (null) with no API key, and when the call fails — never an error, never a made-up string", async () => {
      const forecast = await CashForecastService.generate(owner, { asOfDate: D("2026-10-05"), horizon: "7D" });

      delete process.env.ANTHROPIC_API_KEY;
      expect(await ForecastCommentaryService.forForecast(forecast)).toBeNull();

      process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn().mockRejectedValue(new Error("network down")) }; } }));
      expect(await ForecastCommentaryService.forForecast(forecast)).toBeNull();
    });
  });
});
