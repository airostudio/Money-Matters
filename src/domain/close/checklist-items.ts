import Decimal from "decimal.js";
import type {
  CheckCategory,
  CheckStatus,
  ChecklistItem,
  ChecklistProgress,
  SignoffInfo,
} from "./checklist-types";

/**
 * Pure builders turning MEASUREMENTS (counts/amounts the checklist service
 * queried live) into checklist items. No database, no I/O — so each check's
 * status logic is unit-testable on its own. The wording here is what the user
 * reads, so it is plain language with the real figure in it.
 */

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function item(
  base: Pick<ChecklistItem, "id" | "title" | "category" | "detail"> & Partial<ChecklistItem>,
  status: CheckStatus,
): ChecklistItem {
  return {
    kind: "AUTOMATIC",
    href: null,
    count: null,
    amount: null,
    signoff: null,
    verifiedBy: status === "PASSED" ? "SYSTEM" : null,
    ...base,
    status,
  };
}

// ---------------------------------------------------------------------------
// Banking
// ---------------------------------------------------------------------------

export interface BankAccountMeasure {
  bankAccountId: string;
  name: string;
  /** UNMATCHED transactions dated on/before the period end. */
  unmatchedCount: number;
  /** Of those, how many carry a bank-rule-suggested category that nobody has confirmed. */
  ruleSuggestedCount: number;
  /** Sum of absolute amounts of the unmatched transactions (decimal string). */
  unmatchedAbsAmount: string;
}

export function bankingItems(accounts: BankAccountMeasure[]): ChecklistItem[] {
  if (accounts.length === 0) {
    return [
      item(
        {
          id: "bank.none",
          title: "Bank accounts reconciled",
          category: "BANKING",
          detail: "This organization has no active bank accounts, so there is nothing to reconcile.",
        },
        "NOT_APPLICABLE",
      ),
    ];
  }
  return accounts.map((a) => {
    const href = `/money/${a.bankAccountId}`;
    if (a.unmatchedCount === 0) {
      return item(
        {
          id: `bank.unreconciled:${a.bankAccountId}`,
          title: `${a.name} reconciled`,
          category: "BANKING",
          detail: `Every imported transaction in ${a.name} up to the period end is reconciled.`,
          href,
          count: 0,
        },
        "PASSED",
      );
    }
    const suggested =
      a.ruleSuggestedCount > 0
        ? ` (${a.ruleSuggestedCount} ${plural(a.ruleSuggestedCount, "has", "have")} a rule-suggested category awaiting confirmation)`
        : "";
    return item(
      {
        id: `bank.unreconciled:${a.bankAccountId}`,
        title: `${a.name} reconciled`,
        category: "BANKING",
        detail: `${a.unmatchedCount} bank ${plural(a.unmatchedCount, "transaction")} in ${a.name} ${plural(a.unmatchedCount, "is", "are")} unreconciled${suggested}, totalling ${a.unmatchedAbsAmount} in absolute value.`,
        href,
        count: a.unmatchedCount,
        amount: a.unmatchedAbsAmount,
      },
      "ATTENTION",
    );
  });
}

// ---------------------------------------------------------------------------
// Documents still in draft
// ---------------------------------------------------------------------------

export interface DraftMeasure {
  id: string;
  title: string;
  category: CheckCategory;
  /** e.g. "invoice", "bill", "supplier credit note". */
  noun: string;
  count: number;
  amount: string | null;
  href: string;
  /** Phrase after the count, e.g. "dated in this period" / "submitted but not approved". */
  qualifier: string;
}

export function draftDocumentItem(m: DraftMeasure): ChecklistItem {
  if (m.count === 0) {
    return item(
      {
        id: m.id,
        title: m.title,
        category: m.category,
        detail: `No ${m.noun}s ${m.qualifier}.`,
        href: m.href,
        count: 0,
      },
      "PASSED",
    );
  }
  return item(
    {
      id: m.id,
      title: m.title,
      category: m.category,
      detail: `${m.count} ${plural(m.count, m.noun)} ${m.qualifier}${m.amount ? `, totalling ${m.amount}` : ""}.`,
      href: m.href,
      count: m.count,
      amount: m.amount,
    },
    "ATTENTION",
  );
}

// ---------------------------------------------------------------------------
// Fixed assets, inventory
// ---------------------------------------------------------------------------

export function depreciationItem(m: {
  /** ACTIVE assets acquired on/before the period end. */
  eligibleAssets: number;
  /** Of those, how many have no depreciation entry for the period's month. */
  missingAssets: number;
  monthLabel: string;
}): ChecklistItem {
  const base = { id: "assets.depreciation", title: "Depreciation run", category: "ASSETS" as const, href: "/fixed-assets/depreciation" };
  if (m.eligibleAssets === 0) {
    return item({ ...base, detail: "There are no active fixed assets acquired by this period's end." }, "NOT_APPLICABLE");
  }
  if (m.missingAssets === 0) {
    return item({ ...base, detail: `Depreciation has been run for ${m.monthLabel} for all ${m.eligibleAssets} active ${plural(m.eligibleAssets, "asset")}.`, count: 0 }, "PASSED");
  }
  return item(
    {
      ...base,
      detail: `Depreciation has not been run for ${m.monthLabel} for ${m.missingAssets} of ${m.eligibleAssets} active ${plural(m.eligibleAssets, "asset")}.`,
      count: m.missingAssets,
    },
    "ATTENTION",
  );
}

export interface ReconciliationMeasure {
  id: string;
  title: string;
  category: CheckCategory;
  href: string;
  /** False when the organization has nothing of this kind (no assets / no tracked products). */
  applicable: boolean;
  notApplicableDetail: string;
  /** Names/descriptions of the accounts whose register total disagrees with the GL, with the difference. */
  mismatches: Array<{ name: string; difference: string }>;
  passedDetail: string;
}

/** A register-vs-GL disagreement is a real integrity problem, never rounding, so it BLOCKS. */
export function reconciliationItem(m: ReconciliationMeasure): ChecklistItem {
  const base = { id: m.id, title: m.title, category: m.category, href: m.href };
  if (!m.applicable) return item({ ...base, detail: m.notApplicableDetail }, "NOT_APPLICABLE");
  if (m.mismatches.length === 0) return item({ ...base, detail: m.passedDetail, count: 0 }, "PASSED");
  const list = m.mismatches.map((x) => `${x.name} (difference ${x.difference})`).join("; ");
  return item(
    {
      ...base,
      detail: `${m.mismatches.length} ${plural(m.mismatches.length, "account")} do not reconcile to the general ledger: ${list}.`,
      count: m.mismatches.length,
    },
    "BLOCKING",
  );
}

// ---------------------------------------------------------------------------
// Ledger integrity
// ---------------------------------------------------------------------------

export function trialBalanceItem(m: { totalDebit: string; totalCredit: string; asOf: string }): ChecklistItem {
  const diff = new Decimal(m.totalDebit).minus(m.totalCredit);
  const base = { id: "ledger.trial_balance", title: "Trial balance debits equal credits", category: "LEDGER" as const, href: `/accounting/trial-balance?asOf=${m.asOf}` };
  if (diff.isZero()) {
    return item({ ...base, detail: `Total debits and credits agree (${m.totalDebit}) as at ${m.asOf}.` }, "PASSED");
  }
  return item(
    { ...base, detail: `Total debits ${m.totalDebit} differ from total credits ${m.totalCredit} by ${diff.abs().toFixed(2)} as at ${m.asOf}.`, amount: diff.abs().toFixed(2) },
    "BLOCKING",
  );
}

export function balanceSheetItem(m: {
  balanced: boolean;
  assets: string;
  liabilitiesAndEquity: string;
  difference: string;
  asOf: string;
}): ChecklistItem {
  const base = { id: "ledger.balance_sheet", title: "Balance Sheet balances", category: "LEDGER" as const, href: `/accounting/reports/balance-sheet?asOf=${m.asOf}` };
  if (m.balanced) {
    return item({ ...base, detail: `Assets (${m.assets}) equal liabilities plus equity (${m.liabilitiesAndEquity}) as at ${m.asOf}.` }, "PASSED");
  }
  return item(
    { ...base, detail: `Assets ${m.assets} do not equal liabilities plus equity ${m.liabilitiesAndEquity} as at ${m.asOf} (difference ${m.difference}).`, amount: m.difference },
    "BLOCKING",
  );
}

export interface SuspenseAccountMeasure {
  code: string;
  name: string;
  accountId: string;
  /** Signed balance as at the period end (decimal string). */
  balance: string;
}

export function suspenseItem(accounts: SuspenseAccountMeasure[]): ChecklistItem {
  const base = { id: "ledger.suspense", title: "Suspense and clearing accounts cleared", category: "LEDGER" as const };
  if (accounts.length === 0) {
    return item(
      {
        ...base,
        detail:
          "No suspense, clearing or undeposited-funds accounts exist in this chart of accounts (the platform does not create any by default), so there is nothing to clear.",
      },
      "NOT_APPLICABLE",
    );
  }
  const nonZero = accounts.filter((a) => !new Decimal(a.balance).isZero());
  if (nonZero.length === 0) {
    return item({ ...base, detail: `All ${accounts.length} suspense/clearing ${plural(accounts.length, "account")} have a zero balance at the period end.`, count: 0 }, "PASSED");
  }
  const total = nonZero.reduce((s, a) => s.plus(new Decimal(a.balance).abs()), new Decimal(0));
  return item(
    {
      ...base,
      detail: `${nonZero.length} suspense/clearing ${plural(nonZero.length, "account")} ${plural(nonZero.length, "has", "have")} a non-zero balance: ${nonZero.map((a) => `${a.code} ${a.name} (${a.balance})`).join("; ")}.`,
      href: `/accounting/accounts/${nonZero[0]!.accountId}/transactions`,
      count: nonZero.length,
      amount: total.toFixed(2),
    },
    "ATTENTION",
  );
}

export function draftJournalsItem(m: { count: number }): ChecklistItem {
  const base = { id: "ledger.draft_journals", title: "No draft journal entries", category: "LEDGER" as const, href: "/accounting/journals" };
  if (m.count === 0) return item({ ...base, detail: "There are no draft journal entries dated in this period.", count: 0 }, "PASSED");
  return item({ ...base, detail: `${m.count} draft journal ${plural(m.count, "entry", "entries")} dated in this period ${plural(m.count, "has", "have")} not been posted.`, count: m.count }, "ATTENTION");
}

/**
 * Sequencing: warn (do not block) when the period before this one is not
 * locked although there is posted activity before it. It is a warning, not a
 * block, because businesses legitimately close late or out of order while
 * catching up — but it is an ATTENTION item, so closing needs an explicit,
 * recorded acknowledgement.
 */
export function priorPeriodItem(m: {
  /** Null when there is no posted activity before this period (nothing earlier to close). */
  previous: { label: string; locked: boolean } | null;
}): ChecklistItem {
  const base = { id: "ledger.prior_period", title: "Earlier period closed first", category: "LEDGER" as const, href: "/accounting/close" };
  if (!m.previous) return item({ ...base, detail: "There is no posted activity before this period." }, "NOT_APPLICABLE");
  if (m.previous.locked) return item({ ...base, detail: `The preceding period (${m.previous.label}) is already locked.` }, "PASSED");
  return item({ ...base, detail: `The preceding period (${m.previous.label}) is still open although it has posted activity. Closing out of sequence is allowed but should be deliberate.` }, "ATTENTION");
}

// ---------------------------------------------------------------------------
// Manual sign-off items
// ---------------------------------------------------------------------------

export interface ManualCheckDefinition {
  key: string;
  title: string;
  category: CheckCategory;
  /** What the human is attesting to. */
  prompt: string;
  /** Path after /{orgSlug}; may contain {from}, {to}, {asOf} placeholders (YYYY-MM-DD). */
  href: string | null;
}

/** The ONLY keys a sign-off may be recorded against. */
export const MANUAL_CHECKS: readonly ManualCheckDefinition[] = [
  { key: "manual.accruals", title: "Accruals reviewed", category: "ADJUSTMENTS", prompt: "I have reviewed expenses and income earned or incurred in this period but not yet invoiced or billed, and posted any accrual journals needed.", href: "/accounting/journals/new" },
  { key: "manual.prepayments", title: "Prepayments reviewed", category: "ADJUSTMENTS", prompt: "I have reviewed amounts paid in advance and released the portion that belongs to this period.", href: "/accounting/journals/new" },
  { key: "manual.tax_review", title: "Tax (GST/BAS) reviewed", category: "TAX", prompt: "I have reviewed tax codes and tax balances for this period. (The platform does not lodge returns.)", href: "/accounting/tax-codes" },
  { key: "manual.pnl_review", title: "Profit & Loss reviewed", category: "REVIEW", prompt: "I have reviewed the Profit & Loss for this period and the movements make sense.", href: "/accounting/reports/profit-and-loss?from={from}&to={to}" },
  { key: "manual.balance_sheet_review", title: "Balance Sheet reviewed", category: "REVIEW", prompt: "I have reviewed the Balance Sheet at the period end and the balances make sense.", href: "/accounting/reports/balance-sheet?asOf={to}" },
  { key: "manual.budget_variance", title: "Budget variance reviewed", category: "REVIEW", prompt: "I have reviewed budget vs actual for this period and followed up material variances.", href: "/accounting/reports/budget-vs-actual?from={from}&to={to}" },
  { key: "manual.foreign_exchange", title: "Foreign exchange reviewed", category: "ADJUSTMENTS", prompt: "I have reviewed foreign-currency balances. (Unrealised FX revaluation is not automated by the platform.)", href: null },
  { key: "manual.intercompany", title: "Intercompany balances reviewed", category: "ADJUSTMENTS", prompt: "I have reviewed intercompany balances.", href: null },
];

export const MANUAL_CHECK_KEYS: ReadonlySet<string> = new Set(MANUAL_CHECKS.map((c) => c.key));

export interface ManualContext {
  fxLineCount: number;
  baseCurrency: string;
  budgetCount: number;
  /** Whether the actor may see budget-related items. */
  canSeeBudgets: boolean;
  from: string;
  to: string;
  signoffs: Map<string, SignoffInfo>;
}

export function manualItems(ctx: ManualContext): { items: ChecklistItem[]; hiddenCount: number } {
  const items: ChecklistItem[] = [];
  let hiddenCount = 0;
  for (const def of MANUAL_CHECKS) {
    const href = def.href ? def.href.replace("{from}", ctx.from).replace("{to}", ctx.to).replace("{asOf}", ctx.to) : null;
    const signoff = ctx.signoffs.get(def.key) ?? null;
    const base: Pick<ChecklistItem, "id" | "title" | "category" | "href" | "kind" | "signoff" | "detail"> = {
      id: def.key,
      title: def.title,
      category: def.category,
      href,
      kind: "MANUAL",
      signoff,
      detail: def.prompt,
    };

    if (def.key === "manual.budget_variance") {
      if (!ctx.canSeeBudgets) {
        hiddenCount += 1;
        continue;
      }
      if (ctx.budgetCount === 0) {
        items.push({ ...item({ ...base, detail: "No budget exists, so there is no variance to review.", signoff: null }, "NOT_APPLICABLE"), kind: "MANUAL" });
        continue;
      }
    }
    if (def.key === "manual.foreign_exchange" && ctx.fxLineCount === 0) {
      items.push({ ...item({ ...base, detail: `No foreign-currency transactions (non-${ctx.baseCurrency}) were posted in this period.`, signoff: null }, "NOT_APPLICABLE"), kind: "MANUAL" });
      continue;
    }
    if (def.key === "manual.foreign_exchange") {
      base.detail = `${ctx.fxLineCount} foreign-currency ${plural(ctx.fxLineCount, "line")} posted in this period. Unrealised FX revaluation is not automated by the platform — review and post any revaluation journal yourself.`;
    }
    if (def.key === "manual.intercompany") {
      items.push({
        ...item(
          { ...base, detail: "Intercompany is not modelled: each organization is a single entity, and multi-entity consolidation is a later feature.", signoff: null },
          "NOT_APPLICABLE",
        ),
        kind: "MANUAL",
      });
      continue;
    }

    if (signoff) {
      items.push({ ...item(base, "PASSED"), kind: "MANUAL", verifiedBy: "HUMAN" });
    } else {
      items.push({ ...item(base, "MANUAL"), kind: "MANUAL", verifiedBy: null });
    }
  }
  return { items, hiddenCount };
}

// ---------------------------------------------------------------------------
// Progress and classification
// ---------------------------------------------------------------------------

export const PROGRESS_FORMULA =
  "Month close % = items PASSED (system-verified, or signed off by a named person) ÷ applicable items, where applicable items are all visible items except Not applicable. Items hidden from your role are excluded from both counts.";

export function computeProgress(items: ChecklistItem[]): ChecklistProgress {
  const applicable = items.filter((i) => i.status !== "NOT_APPLICABLE");
  const complete = applicable.filter((i) => i.status === "PASSED").length;
  // With nothing applicable there is nothing outstanding; report 100 rather than dividing by zero.
  const percent = applicable.length === 0 ? 100 : Math.round((complete / applicable.length) * 100);
  return { complete, applicable: applicable.length, percent, formula: PROGRESS_FORMULA };
}

export function classifyItems(items: ChecklistItem[]) {
  return {
    remaining: items.filter((i) => i.status !== "PASSED" && i.status !== "NOT_APPLICABLE"),
    blocking: items.filter((i) => i.status === "BLOCKING"),
    // ATTENTION, plus MANUAL items nobody has signed off yet.
    outstanding: items.filter((i) => i.status === "ATTENTION" || i.status === "MANUAL"),
  };
}
