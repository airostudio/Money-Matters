import "server-only";
import type { CashForecast } from "./types";
import { describeUnscheduledKnown } from "./forecast-summary";
import type { ScenarioRunResult } from "./scenario-service";

/**
 * Optional AI-written plain-language commentary on an ALREADY-COMPUTED
 * forecast or scenario result — the same lightweight pattern as the
 * Management Report Pack and Daily Finance Brief commentary: the model is
 * handed only figures this application already computed, instructed never to
 * calculate or introduce a number, and the whole thing is omitted (returns
 * `null`) when `ANTHROPIC_API_KEY` is unset or the call fails. It is never a
 * source of figures, and never blocks the page.
 *
 * Both fact builders keep KNOWN and STATISTICAL figures under explicit
 * separate labels and the system prompt requires the commentary to keep them
 * distinct — so the assistant can't blur the §38 distinction either.
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export function forecastFacts(f: CashForecast): string[] {
  const facts = [
    `Horizon: ${f.horizon} (${f.horizonDays} days) from ${f.asOf}. Currency ${f.currency}.`,
    `Opening cash (ledger balance of bank accounts): ${f.openingCash.total}.`,
    `KNOWN-COMMITMENTS-ONLY projection (open invoices at due date, open bills, approved payment runs, scheduled recurring templates): ends at ${f.knownOnly.endBalance}; lowest ${f.knownOnly.lowPoint.balance} on ${f.knownOnly.lowPoint.date}; known in ${f.knownOnly.totalIn}, known out ${f.knownOnly.totalOut}.`,
    `INCLUDING-STATISTICAL projection (known commitments plus timing shifts by each customer's historical average lateness${f.payrollOmitted ? "" : " and a repeat of the last pay run"}): ends at ${f.withStatistical.endBalance}; lowest ${f.withStatistical.lowPoint.balance} on ${f.withStatistical.lowPoint.date}.`,
    `Low-cash threshold: ${f.lowCashThreshold}.`,
  ];
  if (f.warning.knownOnly) facts.push(`Known-only projection first falls below the threshold on ${f.warning.knownOnly.date} (in ${f.warning.knownOnly.daysFromNow} day(s)).`);
  if (f.warning.withStatistical) facts.push(`Including-statistical projection first falls below the threshold on ${f.warning.withStatistical.date} (in ${f.warning.withStatistical.daysFromNow} day(s)).`);
  if (!f.warning.knownOnly && !f.warning.withStatistical) facts.push("Neither projection falls below the threshold within the horizon.");
  const unscheduled = describeUnscheduledKnown(f);
  if (unscheduled) facts.push(unscheduled);
  if (f.payrollOmitted) facts.push("Payroll lines were omitted for this user.");
  return facts;
}

export function scenarioFacts(r: ScenarioRunResult): string[] {
  const facts = [
    `Scenario "${r.name}" (${r.type}), ${r.currency}, as of ${r.asOf}. Baseline: ${r.baseline.label}. Opening cash ${r.baseline.openingCash}.`,
  ];
  for (const name of ["BEST", "EXPECTED", "WORST"] as const) {
    const c = r.cases[name];
    const s = c.summary;
    facts.push(
      `${name} case (assumptions: ${c.assumptions.map((a) => `${a.label} ${a.value}`).join("; ")}): 12-month net profit change ${s.twelveMonthNetProfitDelta}; ending cash ${s.scenarioEndCash} vs baseline ${s.baselineEndCash}; ` +
        `runway ${s.scenarioRunwayMonths ?? "beyond the 12 months modelled"} month(s) vs baseline ${s.baselineRunwayMonths ?? "beyond the 12 months modelled"}; break-even ${s.breakEven.status}${s.breakEven.monthlyBreakEvenMonth ? ` (${s.breakEven.monthlyBreakEvenMonth})` : ""}.`,
    );
  }
  for (const d of r.derivedInputs) facts.push(`${d.label}: ${d.value}.`);
  return facts;
}

async function ask(system: string, facts: string[], apiKey: string): Promise<string | null> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, timeout: 15_000 });
    const model = process.env.ANTHROPIC_FORECAST_COMMENTARY_MODEL || DEFAULT_MODEL;
    const message = await client.messages.create({
      model,
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: `Here are the already-computed figures:\n\n${facts.join("\n")}` }],
    });
    const textBlock = message.content.find((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
    return textBlock?.text.trim() || null;
  } catch {
    // Never surface the raw error and never block the feature.
    return null;
  }
}

const FORECAST_SYSTEM =
  "You write a short (3-5 sentence) plain-English commentary on a small business's cash flow forecast for its owner. " +
  "Use ONLY the figures given to you — never calculate, restate with a different value, or introduce any number that " +
  "isn't explicitly listed. Always keep the KNOWN-commitments-only projection and the INCLUDING-statistical projection " +
  "distinct, and say which one a statement is about; statistical projections are estimates from simple averages, not " +
  "certainties. Be direct about any projected low-cash date.";

const SCENARIO_SYSTEM =
  "You write a short (3-5 sentence) plain-English commentary on a what-if scenario for a small business owner. " +
  "Use ONLY the figures given to you — never calculate, restate with a different value, or introduce any number that " +
  "isn't explicitly listed. The Best/Expected/Worst cases differ only by the stated assumptions: describe them as " +
  "assumptions, never as predictions, and never say what 'will' happen.";

export const ForecastCommentaryService = {
  /** `null` when `ANTHROPIC_API_KEY` is unset or the call failed. */
  async forForecast(forecast: CashForecast): Promise<string | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return apiKey ? ask(FORECAST_SYSTEM, forecastFacts(forecast), apiKey) : null;
  },
  async forScenario(result: ScenarioRunResult): Promise<string | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    return apiKey ? ask(SCENARIO_SYSTEM, scenarioFacts(result), apiKey) : null;
  },
};
