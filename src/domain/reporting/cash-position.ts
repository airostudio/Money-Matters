import "server-only";
import type { Actor } from "@/domain/permissions/permission-service";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { LedgerService, type TrialBalanceRow } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";

export interface CashAccountPosition {
  bankAccountId: string;
  name: string;
  institutionName: string | null;
  balance: string;
}

export interface CashPosition {
  currency: string;
  total: string;
  accounts: CashAccountPosition[];
  /**
   * The trial balance rows this position was derived from, handed back so a
   * caller that also needs another GL account's balance (the cash forecast's
   * payroll-liability lines read the payable accounts' balances) reuses the
   * SAME snapshot rather than running a second trial-balance query.
   */
  trialBalance: TrialBalanceRow[];
}

/**
 * Current actual cash: a bank account IS its linked GL account's balance,
 * never a separately tracked number — the same rule `ReportingService.
 * getCashFlowStatement` follows. Extracted verbatim from
 * `DailyFinanceBriefService.generate` (Phase 6 Slice 1) so the Daily Brief
 * and the Phase 9 Slice 2 cash forecast share exactly one definition of
 * "cash on hand" instead of two that could drift apart.
 *
 * Calls are deliberately sequential (two pooled checkouts, one after the
 * other) — see the EMAXCONNSESSION note in `DailyFinanceBriefService.generate`.
 */
export async function loadCashPosition(actor: Actor, asOfDate: Date): Promise<CashPosition> {
  const bankAccounts = await BankAccountService.list(actor);
  const trialBalance = await LedgerService.getTrialBalance(actor, asOfDate);

  const balanceByAccount = new Map(trialBalance.map((r) => [r.accountId, r.balance]));
  // Every bank account in an organization is denominated in the same base
  // currency in this slice (see docs/accounting-engine.md) — fall back to
  // "AUD" only for the degenerate case of an org with no bank accounts yet.
  let currency = bankAccounts[0]?.currency ?? "AUD";
  const accounts: CashAccountPosition[] = bankAccounts.map((ba) => {
    currency = ba.currency;
    return {
      bankAccountId: ba.id,
      name: ba.name,
      institutionName: ba.institutionName,
      balance: balanceByAccount.get(ba.glAccountId) ?? "0.0000",
    };
  });
  const total = accounts.reduce((sum, a) => sum.add(Money.of(a.balance, currency)), Money.zero(currency));

  return { currency, total: total.toString(), accounts, trialBalance };
}
