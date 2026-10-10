import { Money } from "@/domain/money/money";
import {
  INTERCOMPANY_KIND_ACCOUNT_TYPE,
  type EliminationEntry,
  type EliminationEntryLine,
  type EntityStatement,
  type IntercompanyCategory,
  type IntercompanyDef,
  type IntercompanyKind,
  type IntercompanyReconciliationRow,
} from "./types";
import type { AccountType } from "@/domain/accounts/account-service";

/**
 * Intercompany matching and elimination — PRESENTATION-LAYER COMPUTATION ONLY.
 * Nothing here posts, stores or writes anything; an elimination is a computed
 * journal shown beside the consolidated figures. Posting one into an entity's
 * ledger from a group-level action would be a cross-tenant write and is
 * explicitly out of scope (docs/accounting-engine.md section 9).
 *
 * The rules, in the order they matter:
 *
 *  - A user designates entity accounts as intercompany with a NAMED counterparty
 *    entity and a kind. Each kind has a side: the CREDITOR side is the one owed
 *    (receivable, loan receivable, intercompany revenue); the DEBTOR side owes
 *    (payable, loan payable, intercompany expense).
 *  - For an ordered pair (creditor entity A, debtor entity B) and a category
 *    (TRADE / LOAN / INCOME_EXPENSE), side A's total is the sum of A's accounts
 *    designated as the creditor kind with B as counterparty; side B's total is
 *    the sum of B's accounts designated as the debtor kind with A as
 *    counterparty. Both are normal-signed (positive = a balance in the
 *    account's own direction).
 *  - ONLY the MATCHED portion — min(A, B) when both are positive — is
 *    eliminated, equally from both sides. That keeps every consolidated
 *    statement exactly balanced while never forcing a real discrepancy to net
 *    to zero: the leftover stays in the consolidated figures and is reported in
 *    the reconciliation list (amount per side, difference, status).
 *  - A one-sided balance (no counterpart designation or no counterpart
 *    balance), a negative balance, or a counterparty the user has no access to,
 *    eliminates nothing and is reported.
 *  - When a side holds several designated accounts the matched amount is
 *    allocated across the positive balances in account-code order, so the
 *    elimination journal says exactly which accounts it reduced.
 */

const KIND_SIDE: Record<IntercompanyKind, { category: IntercompanyCategory; side: "CREDITOR" | "DEBTOR" }> = {
  RECEIVABLE: { category: "TRADE", side: "CREDITOR" },
  PAYABLE: { category: "TRADE", side: "DEBTOR" },
  LOAN_RECEIVABLE: { category: "LOAN", side: "CREDITOR" },
  LOAN_PAYABLE: { category: "LOAN", side: "DEBTOR" },
  REVENUE: { category: "INCOME_EXPENSE", side: "CREDITOR" },
  EXPENSE: { category: "INCOME_EXPENSE", side: "DEBTOR" },
};

export const BALANCE_SHEET_CATEGORIES: IntercompanyCategory[] = ["TRADE", "LOAN"];
export const PROFIT_AND_LOSS_CATEGORIES: IntercompanyCategory[] = ["INCOME_EXPENSE"];

const CATEGORY_LABEL: Record<IntercompanyCategory, string> = {
  TRADE: "Intercompany receivable / payable",
  LOAN: "Intercompany loan",
  INCOME_EXPENSE: "Intercompany revenue / expense",
};

export interface EliminationInput {
  categories: IntercompanyCategory[];
  /** ONLY entities that are part of this report (authorised, included). */
  statements: EntityStatement[];
  designations: IntercompanyDef[];
  currency: string;
}

/** A reduction to apply to one entity account's contribution. */
export interface AccountReduction {
  organizationId: string;
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  amount: Money;
}

export interface EliminationResult {
  entries: EliminationEntry[];
  reconciliation: IntercompanyReconciliationRow[];
  reductions: AccountReduction[];
}

interface SideDef {
  def: IntercompanyDef;
  balance: Money;
}

interface Pair {
  creditorOrgId: string;
  debtorOrgId: string;
  category: IntercompanyCategory;
  creditor: IntercompanyDef[];
  debtor: IntercompanyDef[];
}

/** Splits `amount` across positive balances (account-code order), never exceeding any one balance. */
function allocate(sides: SideDef[], amount: Money, currency: string): Array<{ side: SideDef; amount: Money }> {
  const out: Array<{ side: SideDef; amount: Money }> = [];
  let remaining = amount;
  const ordered = [...sides].sort((a, b) => a.def.accountCode.localeCompare(b.def.accountCode));
  for (const side of ordered) {
    if (remaining.isZero()) break;
    if (!side.balance.isPositive()) continue;
    const take = side.balance.compareTo(remaining) < 0 ? side.balance : remaining;
    out.push({ side, amount: take });
    remaining = remaining.subtract(take);
  }
  if (!remaining.isZero()) {
    // Cannot happen when `amount <= sum of positive balances`, which the caller
    // guarantees — fail loudly rather than silently under-eliminate.
    throw new Error(`Elimination allocation left ${remaining.toString()} ${currency} unallocated.`);
  }
  return out;
}

export function computeIntercompanyEliminations(input: EliminationInput): EliminationResult {
  const { currency } = input;
  const zero = Money.zero(currency);

  const lineByEntityAccount = new Map<string, { type: AccountType; amount: string; code: string | null; name: string }>();
  const available = new Map<string, EntityStatement>();
  for (const st of input.statements) {
    available.set(st.entity.organizationId, st);
    for (const line of st.lines) {
      if (line.accountId) {
        lineByEntityAccount.set(`${st.entity.organizationId}|${line.accountId}`, {
          type: line.type,
          amount: line.amount,
          code: line.code,
          name: line.name,
        });
      }
    }
  }

  const pairs = new Map<string, Pair>();
  for (const def of input.designations) {
    const meta = KIND_SIDE[def.kind];
    if (!input.categories.includes(meta.category)) continue;
    const creditorOrgId = meta.side === "CREDITOR" ? def.organizationId : def.counterpartyOrganizationId;
    const debtorOrgId = meta.side === "CREDITOR" ? def.counterpartyOrganizationId : def.organizationId;
    const key = `${meta.category}|${creditorOrgId}|${debtorOrgId}`;
    const pair = pairs.get(key) ?? { creditorOrgId, debtorOrgId, category: meta.category, creditor: [], debtor: [] };
    (meta.side === "CREDITOR" ? pair.creditor : pair.debtor).push(def);
    pairs.set(key, pair);
  }

  const entries: EliminationEntry[] = [];
  const reconciliation: IntercompanyReconciliationRow[] = [];
  const reductions: AccountReduction[] = [];

  // Deterministic order regardless of designation insertion order.
  const orderedPairs = [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p);

  for (const pair of orderedPairs) {
    const creditorEntity = available.get(pair.creditorOrgId);
    const debtorEntity = available.get(pair.debtorOrgId);
    if (!creditorEntity && !debtorEntity) continue; // neither side is in this report: nothing to say

    const notes: string[] = [];
    const sideDefs = (defs: IntercompanyDef[], orgId: string, entity: EntityStatement | undefined): SideDef[] => {
      if (!entity) return [];
      const out: SideDef[] = [];
      for (const def of defs) {
        // Only the entity that owns the designation's account contributes it.
        if (def.organizationId !== orgId) continue;
        const line = lineByEntityAccount.get(`${orgId}|${def.accountId}`);
        if (line && line.type !== INTERCOMPANY_KIND_ACCOUNT_TYPE[def.kind]) {
          notes.push(`Account ${def.accountCode} is no longer a ${INTERCOMPANY_KIND_ACCOUNT_TYPE[def.kind].toLowerCase()} account and was ignored.`);
          continue;
        }
        out.push({ def, balance: line ? Money.of(line.amount, currency) : zero });
      }
      return out;
    };

    const creditorSides = sideDefs(pair.creditor, pair.creditorOrgId, creditorEntity);
    const debtorSides = sideDefs(pair.debtor, pair.debtorOrgId, debtorEntity);
    const creditorTotal = creditorSides.reduce((s, x) => s.add(x.balance), zero);
    const debtorTotal = debtorSides.reduce((s, x) => s.add(x.balance), zero);

    // Nothing on either visible side and the other side is simply absent: no row.
    if (creditorTotal.isZero() && debtorTotal.isZero()) continue;

    const bothVisible = !!creditorEntity && !!debtorEntity;
    let matched = zero;
    let status: IntercompanyReconciliationRow["status"];
    const difference = creditorTotal.subtract(debtorTotal);

    if (!bothVisible) {
      status = "COUNTERPARTY_UNAVAILABLE";
    } else if (creditorTotal.isPositive() && debtorTotal.isPositive()) {
      matched = creditorTotal.compareTo(debtorTotal) <= 0 ? creditorTotal : debtorTotal;
      status = difference.isZero() ? "MATCHED" : "MISMATCH";
    } else if (creditorTotal.isZero() || debtorTotal.isZero()) {
      status = "ONE_SIDED";
    } else {
      status = "MISMATCH";
    }

    reconciliation.push({
      category: pair.category,
      creditor: creditorEntity
        ? { organizationId: creditorEntity.entity.organizationId, name: creditorEntity.entity.name, amount: creditorTotal.toString() }
        : null,
      debtor: debtorEntity
        ? { organizationId: debtorEntity.entity.organizationId, name: debtorEntity.entity.name, amount: debtorTotal.toString() }
        : null,
      matched: matched.toString(),
      difference: difference.toString(),
      status,
      note: notes.length ? notes.join(" ") : undefined,
    });

    if (matched.isZero()) continue;

    const creditorAlloc = allocate(creditorSides, matched, currency);
    const debtorAlloc = allocate(debtorSides, matched, currency);

    const lines: EliminationEntryLine[] = [];
    // Dr the debtor-side accounts (payable / loan payable / expense is reduced
    // by a CREDIT, receivable by... see below). Eliminating means REMOVING the
    // balance, i.e. the opposite entry to the one that created it:
    //   TRADE / LOAN: Dr Payable (liability), Cr Receivable (asset)
    //   INCOME_EXPENSE: Dr Revenue, Cr Expense
    const debitSide = pair.category === "INCOME_EXPENSE" ? creditorAlloc : debtorAlloc;
    const creditSide = pair.category === "INCOME_EXPENSE" ? debtorAlloc : creditorAlloc;
    const lineOf = (a: { side: SideDef; amount: Money }, side: "DEBIT" | "CREDIT"): EliminationEntryLine => ({
      organizationId: a.side.def.organizationId,
      accountId: a.side.def.accountId,
      code: a.side.def.accountCode,
      name: a.side.def.accountName,
      type: INTERCOMPANY_KIND_ACCOUNT_TYPE[a.side.def.kind],
      side,
      amount: a.amount.toString(),
    });
    for (const a of debitSide) lines.push(lineOf(a, "DEBIT"));
    for (const a of creditSide) lines.push(lineOf(a, "CREDIT"));

    for (const a of [...creditorAlloc, ...debtorAlloc]) {
      reductions.push({
        organizationId: a.side.def.organizationId,
        accountId: a.side.def.accountId,
        // The code the entity's own statement reported (it is what the
        // mapping rule matches on), falling back to the designation snapshot.
        code: lineByEntityAccount.get(`${a.side.def.organizationId}|${a.side.def.accountId}`)?.code ?? a.side.def.accountCode,
        name: a.side.def.accountName,
        type: INTERCOMPANY_KIND_ACCOUNT_TYPE[a.side.def.kind],
        amount: a.amount,
      });
    }

    entries.push({
      id: `elim:${pair.category}:${pair.creditorOrgId}:${pair.debtorOrgId}`,
      category: pair.category,
      description: `${CATEGORY_LABEL[pair.category]}: ${creditorEntity!.entity.name} and ${debtorEntity!.entity.name}`,
      amount: matched.toString(),
      lines,
    });
  }

  return { entries, reconciliation, reductions };
}
