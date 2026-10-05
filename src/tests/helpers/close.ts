import { BankAccountService } from "@/domain/banking/bank-account-service";
import { BankImportService } from "@/domain/banking/bank-import-service";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { createSampleAccounts } from "./ledger";
import { createSalesFixtures } from "./sales";

export const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * September 2026 with real activity and two deliberately open items, for the
 * month-end close tests: a posted journal (bank/revenue 1,000.00), ONE
 * unreconciled bank transaction in "Everyday Account" (-4.50 on 15 Sep), and
 * ONE DRAFT invoice dated 10 Sep. Fixing the first (`categorize`) or second
 * (`approveInvoice`) should flip the matching automatic check.
 */
export async function seedCloseScenario(owner: Actor, currency: string) {
  const accountIds = await createSampleAccounts(owner, currency);
  const bankGl = accountIds[0]!;
  const revenue = accountIds[4]!;
  const expense = accountIds[5]!;
  const sales = await createSalesFixtures(owner, currency);

  const bankAccount = await BankAccountService.create(owner, { name: "Everyday Account", glAccountId: bankGl, currency });
  await PostingService.postJournal(owner, {
    postingDate: D("2026-09-02"),
    memo: "Opening cash",
    lines: [
      { accountId: bankGl, debit: "1000.00", currency },
      { accountId: revenue, credit: "1000.00", currency },
    ],
  });
  await BankImportService.importStatement(owner, {
    bankAccountId: bankAccount.id,
    format: "CSV",
    fileName: "sept.csv",
    text: ["Date,Description,Amount", "15/09/2026,Morning Coffee,-4.50"].join("\n"),
  });
  const [bankTxn] = await ReconciliationService.listUnreconciled(owner, bankAccount.id);

  const draftInvoice = await InvoiceService.create(owner, {
    customerContactId: sales.customerContactId,
    issueDate: D("2026-09-10"),
    dueDate: D("2026-10-10"),
    currency,
    arAccountId: sales.arAccountId,
    lines: [{ description: "Consulting", quantity: "1", unitPrice: "200.00", accountId: sales.revenueAccountId }],
  });

  return {
    bankGl,
    revenue,
    expense,
    bankAccountId: bankAccount.id,
    bankTxnId: bankTxn!.id,
    draftInvoiceId: draftInvoice.id,
    /** Fix the unreconciled bank transaction by categorising it (posts a journal dated 15 Sep). */
    categorize: () => ReconciliationService.createJournalFromTransaction(owner, bankTxn!.id, { categorizedAccountId: expense }),
    /** Fix the draft invoice by approving and posting it. */
    approveInvoice: () => InvoiceService.approveAndPost(owner, draftInvoice.id),
  };
}

export type CloseScenario = Awaited<ReturnType<typeof seedCloseScenario>>;
