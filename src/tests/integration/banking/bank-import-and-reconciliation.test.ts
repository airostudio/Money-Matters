import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSampleAccounts } from "../../helpers/ledger";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { BankImportService } from "@/domain/banking/bank-import-service";
import { BankRuleService } from "@/domain/banking/bank-rule-service";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { BankTransactionAlreadyMatchedError } from "@/domain/banking/errors";
import { PostingService } from "@/domain/ledger/posting-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import type { Actor } from "@/domain/permissions/permission-service";

const CSV_STATEMENT = [
  "Date,Description,Amount",
  "15/01/2026,Morning Coffee,-4.50",
  "16/01/2026,Client Payment,1200.00",
].join("\n");

describe("Bank import + reconciliation (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let organizationId: string;
  let bankGlAccountId: string;
  let expenseAccountId: string;
  let revenueAccountId: string;
  let bankAccountId: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("banking");
    owner = org.owner;
    organizationId = org.organizationId;
    const accountIds = await createSampleAccounts(owner, org.baseCurrency);
    bankGlAccountId = accountIds[0]!;
    revenueAccountId = accountIds[4]!;
    expenseAccountId = accountIds[5]!;

    const bankAccount = await BankAccountService.create(owner, {
      name: "Everyday Account",
      glAccountId: bankGlAccountId!,
      currency: org.baseCurrency,
      institutionName: "Test Bank",
    });
    bankAccountId = bankAccount.id;
  });

  it("rejects linking a bank account to a non-ASSET ledger account", async () => {
    await expect(
      BankAccountService.create(owner, {
        name: "Bad link",
        glAccountId: revenueAccountId,
        currency: "AUD",
      }),
    ).rejects.toThrow(/ASSET/);
  });

  it("imports a CSV statement into staged, unmatched transactions", async () => {
    const result = await BankImportService.importStatement(owner, {
      bankAccountId,
      format: "CSV",
      fileName: "statement.csv",
      text: CSV_STATEMENT,
    });

    expect(result.importedRowCount).toBe(2);
    expect(result.duplicateRowCount).toBe(0);

    const unreconciled = await ReconciliationService.listUnreconciled(owner, bankAccountId);
    expect(unreconciled).toHaveLength(2);
    expect(unreconciled.every((t) => t.status === "UNMATCHED")).toBe(true);
  });

  it("re-importing the same statement is a no-op — nothing is duplicated", async () => {
    await BankImportService.importStatement(owner, { bankAccountId, format: "CSV", text: CSV_STATEMENT });
    const second = await BankImportService.importStatement(owner, { bankAccountId, format: "CSV", text: CSV_STATEMENT });

    expect(second.importedRowCount).toBe(0);
    expect(second.duplicateRowCount).toBe(2);

    const unreconciled = await ReconciliationService.listUnreconciled(owner, bankAccountId);
    expect(unreconciled).toHaveLength(2);
  });

  it("auto-categorizes a newly-imported transaction using a matching bank rule", async () => {
    await BankRuleService.create(owner, {
      name: "Coffee to General Expenses",
      conditions: [{ field: "description", operator: "CONTAINS", value: "coffee" }],
      actions: { categorizedAccountId: expenseAccountId },
    });

    await BankImportService.importStatement(owner, { bankAccountId, format: "CSV", text: CSV_STATEMENT });

    const [coffee] = await ReconciliationService.listUnreconciled(owner, bankAccountId);
    expect(coffee?.categorizedAccountId).toBe(expenseAccountId);
    expect(coffee?.appliedRuleId).not.toBeNull();
  });

  it("posts a new balanced journal entry from an uncategorized transaction and marks it reconciled", async () => {
    await BankImportService.importStatement(owner, { bankAccountId, format: "CSV", text: CSV_STATEMENT });
    const [coffee] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    const result = await ReconciliationService.createJournalFromTransaction(owner, coffee!.id, {
      categorizedAccountId: expenseAccountId,
    });

    expect(result.status).toBe("RECONCILED");
    expect(result.matchedJournalLineId).not.toBeNull();

    const entry = await LedgerService.getJournalEntry(owner, result.journalEntry.entryId);
    expect(entry?.status).toBe("POSTED");
    expect(entry?.sourceType).toBe("BANK_TRANSACTION");
    const totalDebit = entry!.lines.reduce((sum, l) => sum + Number(l.debit), 0);
    const totalCredit = entry!.lines.reduce((sum, l) => sum + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit);
    expect(totalDebit).toBeCloseTo(4.5);

    const stillUnmatched = await ReconciliationService.listUnreconciled(owner, bankAccountId);
    expect(stillUnmatched).toHaveLength(1);
  });

  it("finds an existing posted journal line as a high-confidence candidate match", async () => {
    const posted = await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-16"),
      memo: "Client payment received",
      lines: [
        { accountId: bankGlAccountId!, debit: "1200.00", currency: "AUD" },
        { accountId: revenueAccountId, credit: "1200.00", currency: "AUD" },
      ],
    });

    await BankImportService.importStatement(owner, { bankAccountId, format: "CSV", text: CSV_STATEMENT });
    const transactions = await ReconciliationService.listUnreconciled(owner, bankAccountId);
    const payment = transactions.find((t) => t.description === "Client Payment")!;

    const candidates = await ReconciliationService.findCandidateMatches(owner, payment.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ journalEntryId: posted.entryId, confidence: 1 });
    expect(candidates[0]?.explanation).toMatch(/match exactly/);

    const confirmed = await ReconciliationService.confirmMatch(owner, payment.id, candidates[0]!.journalLineId);
    expect(confirmed?.status).toBe("RECONCILED");
    expect(confirmed?.matchedJournalLineId).toBe(candidates[0]!.journalLineId);
  });

  it("refuses to reconcile the same transaction twice", async () => {
    await BankImportService.importStatement(owner, { bankAccountId, format: "CSV", text: CSV_STATEMENT });
    const [coffee] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    await ReconciliationService.createJournalFromTransaction(owner, coffee!.id, {
      categorizedAccountId: expenseAccountId,
    });

    await expect(
      ReconciliationService.createJournalFromTransaction(owner, coffee!.id, {
        categorizedAccountId: expenseAccountId,
      }),
    ).rejects.toThrow(BankTransactionAlreadyMatchedError);
  });

  it("excludes a transaction with no ledger effect", async () => {
    await BankImportService.importStatement(owner, { bankAccountId, format: "CSV", text: CSV_STATEMENT });
    const [coffee] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    const excluded = await ReconciliationService.exclude(owner, coffee!.id, "Personal, not business");
    expect(excluded?.status).toBe("EXCLUDED");

    const stillUnmatched = await ReconciliationService.listUnreconciled(owner, bankAccountId);
    expect(stillUnmatched).toHaveLength(1);
  });

  it("denies import to a role without bank_transaction:import", async () => {
    const employee = actorWithRole(owner, "EMPLOYEE");
    await expect(
      BankImportService.importStatement(employee, { bankAccountId, format: "CSV", text: CSV_STATEMENT }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("never returns another organization's bank account", async () => {
    const otherOrg = await createTestOrg("other-banking");
    const found = await BankAccountService.get(otherOrg.owner, bankAccountId);
    expect(found).toBeNull();
  });

  it("keeps organizationId consistent through the whole flow for tenant isolation to key off", async () => {
    const bankAccount = await BankAccountService.get(owner, bankAccountId);
    expect(bankAccount?.organizationId).toBe(organizationId);
  });
});
