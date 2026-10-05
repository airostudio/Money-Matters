/**
 * Specialist agents (master spec §9), Phase 6 Slice 2. Per docs/ai-agents.md
 * §4's design: each "agent" is a named, narrower view over the same
 * Controller loop and the same fixed tool registries
 * (`controller-tools.ts`/`write-tools.ts`) — a selected tool subset plus a
 * system-prompt addendum, never a separate orchestration framework, a
 * separate permission system, or bespoke data access. Selecting an agent
 * mode never grants a tool a plain Controller conversation couldn't already
 * use; it only narrows (and tailors the framing of) what's offered.
 *
 * **Bookkeeping** gets no new write tool in this slice: bank-transaction
 * posting/categorization isn't in this slice's write-tool list (only
 * invoice/bill/journal-entry preparation is), so at Level 2 it's still
 * read-only — a system-prompt specialization today, with
 * `prepare_draft_journal_entry` as its one write capability for the
 * "unusual manual adjustment" case §9 describes.
 *
 * **Payroll and Tax & Compliance are deliberately NOT built** — see
 * `DEFERRED_AGENTS` below and docs/roadmap.md. There is no payroll or
 * tax-filing domain in this codebase yet (Phase 8 hasn't started), so an
 * agent "for" either would have no real tool behind it — exactly the
 * shallow-stub this codebase's roadmap refuses to ship.
 */

export type AgentMode = "GENERAL" | "BOOKKEEPING" | "AR" | "AP" | "FPA";

export interface AgentModeDefinition {
  id: AgentMode;
  label: string;
  description: string;
  /** `null` means "every read tool" (the General Controller's Slice 1 behavior). */
  readToolNames: string[] | null;
  /** Subset of `write-tools.ts`'s tool names this mode may use — still gated by the org's autonomy level regardless. */
  writeToolNames: string[];
  systemPromptAddendum: string;
}

export const AGENT_MODES: Record<AgentMode, AgentModeDefinition> = {
  GENERAL: {
    id: "GENERAL",
    label: "Financial Controller",
    description: "General-purpose assistant over every report and record this organization can see.",
    readToolNames: null,
    writeToolNames: ["prepare_draft_invoice", "prepare_draft_bill", "prepare_draft_journal_entry"],
    systemPromptAddendum: "",
  },
  BOOKKEEPING: {
    id: "BOOKKEEPING",
    label: "Bookkeeping",
    description: "Day-to-day ledger questions: balances, trial balance, and specific transaction lookups.",
    readToolNames: ["trial_balance", "find_invoice", "find_bill", "find_expense_claim", "run_report"],
    writeToolNames: ["prepare_draft_journal_entry"],
    systemPromptAddendum:
      "You are specialized in bookkeeping: account balances, the trial balance, and finding specific transactions. " +
      "You do not have access to this organization's aged receivables/payables or P&L/Balance Sheet reports in this mode — " +
      "if asked about those, say the user should switch to the AR, AP, or FP&A mode instead.",
  },
  AR: {
    id: "AR",
    label: "Accounts Receivable",
    description: "Who owes us money, overdue invoices and collection priority, and drafting new customer invoices.",
    readToolNames: ["aged_receivables", "find_invoice", "run_report"],
    writeToolNames: ["prepare_draft_invoice"],
    systemPromptAddendum:
      "You are the Accounts Receivable specialist: overdue customer invoices, collection priority, and invoicing. " +
      "You may prepare a draft customer invoice when asked (never create it yourself — the user must confirm it). " +
      "You do not have access to supplier bills or general ledger reports in this mode.",
  },
  AP: {
    id: "AP",
    label: "Accounts Payable",
    description: "What we owe, overdue bills, and drafting new supplier bills.",
    readToolNames: ["aged_payables", "find_bill", "run_report"],
    writeToolNames: ["prepare_draft_bill"],
    systemPromptAddendum:
      "You are the Accounts Payable specialist: overdue supplier bills and entering new bills. " +
      "You may prepare a draft supplier bill when asked (never create it yourself — the user must confirm it). " +
      "You do not have access to customer invoices or general ledger reports in this mode.",
  },
  FPA: {
    id: "FPA",
    label: "FP&A",
    description: "Profitability, trend, and KPI analysis over existing financial reports, plus the cash flow forecast (known commitments vs. statistical projections). No budgeting tool exists yet.",
    readToolNames: ["profit_and_loss", "balance_sheet", "trial_balance", "run_report", "cash_forecast"],
    writeToolNames: [],
    systemPromptAddendum:
      "You are the FP&A (financial planning & analysis) specialist: profitability, trend, and KPI analysis using the " +
      "organization's real reports, and the cash flow forecast (cash_forecast: known commitments and statistical " +
      "projections are two separate projections — always say which one you mean). You have no tool for budgets or " +
      "what-if scenarios — if asked to compare against a budget or to model a scenario, say plainly that you can't " +
      "do that from chat (the user can use the Budgets and Scenarios pages) rather than inventing a number.",
  },
};

export const AGENT_MODE_IDS = Object.keys(AGENT_MODES) as AgentMode[];

export function isAgentMode(value: string): value is AgentMode {
  return value in AGENT_MODES;
}

/**
 * Documented, not built — see this module's doc comment. Exposed so the UI
 * can show these as visibly disabled options with an honest reason, rather
 * than omitting them with no explanation (master spec §6's "a why, shown
 * not hidden" extended to what ISN'T built, not just what is).
 */
export const DEFERRED_AGENTS: { label: string; reason: string }[] = [
  {
    label: "Payroll",
    reason: "No payroll domain exists yet (Phase 8, not started) — there is no real tool this agent could call.",
  },
  {
    label: "Tax & Compliance",
    reason: "No tax-filing/BAS domain exists yet (Phase 8, not started) — there is no real tool this agent could call.",
  },
];
