import "server-only";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { AgedReceivablesService, type PrioritizedInvoiceRow } from "@/domain/sales/aged-receivables-service";
import { AgedPayablesService, type AgedBillRow } from "@/domain/purchases/aged-payables-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { AutoExecutionService } from "@/domain/ai-controller/auto-execution-service";
import { Money } from "@/domain/money/money";
import { formatDateParam } from "./period-presets";

/**
 * Master spec §73's Daily Finance Brief. Every figure is computed fresh from
 * the exact domain services the rest of the app already uses — no new
 * aggregation logic, no cached/duplicated numbers:
 *   - cash position: `LedgerService.getTrialBalance` filtered to the GL
 *     accounts the banking module already links each bank account to
 *     (`BankAccountService.list`'s `glAccountId`) — the same "a bank account
 *     IS its linked GL account's balance, never a separately-tracked number"
 *     rule `ReportingService.getCashFlowStatement` already follows.
 *   - money in/out expected in the next 7 days and overdue receivables:
 *     `AgedReceivablesService`/`AgedPayablesService`, which already compute
 *     every unpaid invoice/bill's days-until/-past its due date.
 *   - payments requiring approval: `PaymentRunService.list` filtered to
 *     `AWAITING_APPROVAL`, the same status the Payment Runs page itself
 *     filters by.
 *
 * Gated on `financial_report:read` as a single check for the whole brief
 * (like the Management Report Pack) — every role that holds it also holds
 * the narrower `bank_account:read`/`customer_invoice:read`/
 * `supplier_bill:read`/`payment_run:read` permissions each section's own
 * service call independently re-asserts anyway (see `roles.ts`), so this is
 * belt-and-braces, not a widening of access.
 *
 * **What's deferred**: master spec §73 also describes this brief running on
 * a *schedule* and being *emailed* every morning. No job-queue/scheduler
 * infrastructure exists in this codebase (the same gap documented since
 * Phase 2 Slice 2 and carried forward through the Management Report Pack —
 * see `management-pack-service.ts`), so only the on-demand version is built
 * here. Building a fake "scheduled" toggle with nothing behind it would be
 * exactly the shallow-stub this codebase's roadmap explicitly refuses to
 * ship.
 */

export interface CashAccountPosition {
  bankAccountId: string;
  name: string;
  institutionName: string | null;
  balance: string;
}

export interface PaymentRunAwaitingApproval {
  id: string;
  runNumber: string;
  totalAmount: string;
  currency: string;
}

export interface DailyFinanceBrief {
  asOf: string;
  currency: string;
  cash: { total: string; accounts: CashAccountPosition[] };
  next7Days: { expectedIn: string; expectedOut: string };
  overdueReceivables: { count: number; total: string; topPriority: PrioritizedInvoiceRow[] };
  overduePayables: { count: number; total: string };
  paymentRunsAwaitingApproval: PaymentRunAwaitingApproval[];
  /** Phase 6 Slice 3 (master spec §77: surface auto-executed items wherever they appear, not just in the audit log) — count of auto-executed actions in this brief's lookback window, so an owner sees at a glance whether the AI did anything unattended. */
  recentAiAutoExecutions: number;
  callouts: string[];
  /** `null` when `ANTHROPIC_API_KEY` is unset or the call failed — the brief is complete and useful without it. */
  aiSummary: string | null;
}

function inNext7Days(daysPastDue: number): boolean {
  // `daysPastDue` is `asOfDate − dueDate`: negative means still in the
  // future. "Within the next 7 days" is 0 (due today) down to -7.
  return daysPastDue <= 0 && daysPastDue >= -7;
}

async function generateAiSummary(facts: string[], apiKey: string): Promise<string | null> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, timeout: 15_000 });
    const model = process.env.ANTHROPIC_DAILY_BRIEF_MODEL || "claude-haiku-4-5-20251001";

    const message = await client.messages.create({
      model,
      max_tokens: 300,
      system:
        "You write a short (2-4 sentence) plain-English summary of a small business's daily finance brief for its owner. " +
        "Use ONLY the figures given to you — never calculate, restate with a different value, or introduce any number " +
        "that isn't explicitly listed. Be direct about anything that needs attention.",
      messages: [{ role: "user", content: `Today's figures:\n\n${facts.join("\n")}` }],
    });

    const textBlock = message.content.find((b): b is Extract<typeof b, { type: "text" }> => b.type === "text");
    return textBlock?.text.trim() || null;
  } catch {
    return null;
  }
}

export const DailyFinanceBriefService = {
  async generate(actor: Actor, asOfDate: Date = new Date()): Promise<DailyFinanceBrief> {
    assertPermission(actor, "financial_report:read");

    // Sequential, not Promise.all: each of these opens its own pooled DB
    // connection (every domain-service call runs inside its own
    // withTenant() transaction — see src/db/tenant.ts). Six concurrent
    // checkouts for one page render is what exhausted Supabase's
    // session-mode pooler (capped at 15 clients total for the project) under
    // real traffic — see the EMAXCONNSESSION incident. This trades a little
    // latency for not needing six connections free at once.
    const bankAccounts = await BankAccountService.list(actor);
    const trialBalance = await LedgerService.getTrialBalance(actor, asOfDate);
    const receivables = await AgedReceivablesService.getWithPriority(actor, asOfDate);
    const payables = await AgedPayablesService.get(actor, asOfDate);
    const awaitingApproval = await PaymentRunService.list(actor, { status: "AWAITING_APPROVAL" });
    const recentAutoExecutions = await AutoExecutionService.listRecent(actor.organizationId, 50);

    const balanceByAccount = new Map(trialBalance.map((r) => [r.accountId, r.balance]));
    // Every bank account in an organization is denominated in the same base
    // currency in this slice (see docs/accounting-engine.md) — fall back to
    // "AUD" only for the degenerate case of an org with no bank accounts yet.
    let cashCurrency = bankAccounts[0]?.currency ?? "AUD";
    const cashAccounts: CashAccountPosition[] = bankAccounts.map((ba) => {
      cashCurrency = ba.currency;
      return {
        bankAccountId: ba.id,
        name: ba.name,
        institutionName: ba.institutionName,
        balance: balanceByAccount.get(ba.glAccountId) ?? "0.0000",
      };
    });
    const totalCash = cashAccounts.reduce((sum, a) => sum.add(Money.of(a.balance, cashCurrency)), Money.zero(cashCurrency));

    const overdueReceivableRows = receivables.filter((r) => r.daysPastDue > 0);
    const overdueReceivablesTotal = overdueReceivableRows.reduce(
      (sum, r) => sum.add(Money.of(r.outstanding, cashCurrency)),
      Money.zero(cashCurrency),
    );
    const upcomingReceivables = receivables.filter((r) => inNext7Days(r.daysPastDue));
    const expectedIn = upcomingReceivables.reduce((sum, r) => sum.add(Money.of(r.outstanding, cashCurrency)), Money.zero(cashCurrency));

    const flatPayableBills: AgedBillRow[] = payables.flatMap((s) => s.bills);
    const overduePayableBills = flatPayableBills.filter((b) => b.daysPastDue > 0);
    const overduePayablesTotal = overduePayableBills.reduce((sum, b) => sum.add(Money.of(b.outstanding, cashCurrency)), Money.zero(cashCurrency));
    const upcomingPayables = flatPayableBills.filter((b) => inNext7Days(b.daysPastDue));
    const expectedOut = upcomingPayables.reduce((sum, b) => sum.add(Money.of(b.outstanding, cashCurrency)), Money.zero(cashCurrency));

    const paymentRunsAwaitingApproval: PaymentRunAwaitingApproval[] = awaitingApproval.map((r) => ({
      id: r.id,
      runNumber: r.runNumber,
      totalAmount: r.totalAmount,
      currency: r.currency,
    }));

    const oneDayMs = 24 * 60 * 60 * 1000;
    const recentAiAutoExecutions = recentAutoExecutions.filter(
      (e) => !e.reversedAt && asOfDate.getTime() - e.createdAt.getTime() <= oneDayMs,
    ).length;

    const callouts: string[] = [];
    if (recentAiAutoExecutions > 0) {
      callouts.push(
        `The AI Financial Controller auto-executed ${recentAiAutoExecutions} whitelisted action(s) in the last 24 hours under this organization's autonomy policy — see Settings for the whitelist, or the audit trail for details.`,
      );
    }
    if (overdueReceivableRows.length > 0) {
      const top = [...overdueReceivableRows].sort((a, b) => b.priorityScore - a.priorityScore)[0]!;
      callouts.push(
        `${overdueReceivableRows.length} invoice(s) are overdue totaling ${overdueReceivablesTotal.toString()} ${cashCurrency} — ${top.customerName} (invoice ${top.invoiceNumber}, ${top.daysPastDue} days overdue) is the highest collection priority.`,
      );
    }
    if (paymentRunsAwaitingApproval.length > 0) {
      const total = paymentRunsAwaitingApproval.reduce((sum, r) => sum.add(Money.of(r.totalAmount, r.currency)), Money.zero(cashCurrency));
      callouts.push(`${paymentRunsAwaitingApproval.length} payment run(s) totaling ${total.toString()} ${cashCurrency} are awaiting your approval.`);
    }
    if (expectedOut.isPositive() && expectedOut.compareTo(totalCash) > 0) {
      callouts.push(
        `Cash may be tight over the next 7 days: ${expectedOut.toString()} ${cashCurrency} expected out vs. ${totalCash.toString()} ${cashCurrency} on hand now.`,
      );
    }
    if (overduePayableBills.length > 0) {
      callouts.push(`${overduePayableBills.length} supplier bill(s) are overdue totaling ${overduePayablesTotal.toString()} ${cashCurrency}.`);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const aiSummary = apiKey
      ? await generateAiSummary(
          [
            `Total cash on hand: ${totalCash.toString()} ${cashCurrency} across ${cashAccounts.length} account(s).`,
            `Expected in over next 7 days: ${expectedIn.toString()} ${cashCurrency}.`,
            `Expected out over next 7 days: ${expectedOut.toString()} ${cashCurrency}.`,
            `Overdue receivables: ${overdueReceivableRows.length} invoice(s), ${overdueReceivablesTotal.toString()} ${cashCurrency}.`,
            `Overdue payables: ${overduePayableBills.length} bill(s), ${overduePayablesTotal.toString()} ${cashCurrency}.`,
            `Payment runs awaiting approval: ${paymentRunsAwaitingApproval.length}.`,
          ],
          apiKey,
        )
      : null;

    return {
      asOf: formatDateParam(asOfDate),
      currency: cashCurrency,
      cash: { total: totalCash.toString(), accounts: cashAccounts },
      next7Days: { expectedIn: expectedIn.toString(), expectedOut: expectedOut.toString() },
      overdueReceivables: {
        count: overdueReceivableRows.length,
        total: overdueReceivablesTotal.toString(),
        topPriority: [...overdueReceivableRows].sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 5),
      },
      overduePayables: { count: overduePayableBills.length, total: overduePayablesTotal.toString() },
      paymentRunsAwaitingApproval,
      recentAiAutoExecutions,
      callouts,
      aiSummary,
    };
  },
};
