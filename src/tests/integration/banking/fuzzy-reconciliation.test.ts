import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSampleAccounts } from "../../helpers/ledger";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { BankImportService } from "@/domain/banking/bank-import-service";
import { FuzzyReconciliationService } from "@/domain/banking/fuzzy-reconciliation-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Fuzzy (AI-assisted) reconciliation (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  let owner: Actor;
  let bankGlAccountId: string;
  let expenseAccountId: string;
  let bankAccountId: string;
  let nearAmountJournalLineId: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("fuzzy-reconciliation");
    owner = org.owner;
    const accountIds = await createSampleAccounts(owner, org.baseCurrency);
    bankGlAccountId = accountIds[0]!;
    expenseAccountId = accountIds[5]!;

    const bankAccount = await BankAccountService.create(owner, {
      name: "Everyday Account",
      glAccountId: bankGlAccountId,
      currency: org.baseCurrency,
      institutionName: "Test Bank",
    });
    bankAccountId = bankAccount.id;

    // A posted journal entry crediting the bank account for 98.00 — close to,
    // but not exactly, the $100 bank transaction imported below, so the
    // deterministic exact-amount pass finds nothing.
    const posted = await PostingService.postJournal(owner, {
      postingDate: new Date("2026-01-10"),
      memo: "Office supplies (approx.)",
      lines: [
        { accountId: expenseAccountId, debit: "98.00", currency: "AUD" },
        { accountId: bankGlAccountId, credit: "98.00", currency: "AUD" },
      ],
    });
    const { LedgerService } = await import("@/domain/ledger/ledger-service");
    const entry = await LedgerService.getJournalEntry(owner, posted.entryId);
    nearAmountJournalLineId = entry!.lines.find((l) => l.accountId === bankGlAccountId)!.id;
  });

  async function importUnmatchedTransaction() {
    const result = await BankImportService.importStatement(owner, {
      bankAccountId,
      format: "CSV",
      fileName: "statement.csv",
      text: ["Date,Description,Amount", "12/01/2026,Office Supplies Store,-100.00"].join("\n"),
    });
    return result;
  }

  it("returns no suggestions when ANTHROPIC_API_KEY is unset — never an error", async () => {
    await importUnmatchedTransaction();
    const { ReconciliationService } = await import("@/domain/banking/reconciliation-service");
    const [unreconciled] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    const suggestions = await FuzzyReconciliationService.suggestMatches(owner, unreconciled!.id);
    expect(suggestions).toEqual([]);
  });

  it("returns a validated AI suggestion referencing a real near-amount journal line", async () => {
    await importUnmatchedTransaction();
    const { ReconciliationService } = await import("@/domain/banking/reconciliation-service");
    const [unreconciled] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    process.env.ANTHROPIC_API_KEY = "fake-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                name: "suggest_bank_matches",
                input: {
                  suggestions: [
                    {
                      candidateJournalLineId: nearAmountJournalLineId,
                      confidence: 0.72,
                      reasoning: "Amount is within 2% and posted 2 days earlier; description is plausibly related.",
                    },
                  ],
                },
              },
            ],
          }),
        };
      },
    }));

    const { FuzzyReconciliationService: MockedService } = await import(
      "@/domain/banking/fuzzy-reconciliation-service"
    );
    const suggestions = await MockedService.suggestMatches(owner, unreconciled!.id);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.journalLineId).toBe(nearAmountJournalLineId);
    expect(suggestions[0]!.source).toBe("AI");
    expect(suggestions[0]!.confidence).toBe(0.72);
  });

  it("drops a suggestion referencing an id that was never in the candidate pool — never trusts an invented id", async () => {
    await importUnmatchedTransaction();
    const { ReconciliationService } = await import("@/domain/banking/reconciliation-service");
    const [unreconciled] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    process.env.ANTHROPIC_API_KEY = "fake-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                name: "suggest_bank_matches",
                input: {
                  suggestions: [
                    {
                      candidateJournalLineId: "00000000-0000-0000-0000-000000000000",
                      confidence: 0.9,
                      reasoning: "invented id, never sent to the model",
                    },
                  ],
                },
              },
            ],
          }),
        };
      },
    }));

    const { FuzzyReconciliationService: MockedService } = await import(
      "@/domain/banking/fuzzy-reconciliation-service"
    );
    const suggestions = await MockedService.suggestMatches(owner, unreconciled!.id);
    expect(suggestions).toEqual([]);
  });

  it("returns no suggestions (never throws) when the AI call fails", async () => {
    await importUnmatchedTransaction();
    const { ReconciliationService } = await import("@/domain/banking/reconciliation-service");
    const [unreconciled] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    process.env.ANTHROPIC_API_KEY = "fake-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("network unreachable")) };
      },
    }));

    const { FuzzyReconciliationService: MockedService } = await import(
      "@/domain/banking/fuzzy-reconciliation-service"
    );
    const suggestions = await MockedService.suggestMatches(owner, unreconciled!.id);
    expect(suggestions).toEqual([]);
  });

  it("refuses a READ_ONLY actor — this is a distinct, gated action from bank_transaction:reconcile", async () => {
    await importUnmatchedTransaction();
    const { ReconciliationService } = await import("@/domain/banking/reconciliation-service");
    const [unreconciled] = await ReconciliationService.listUnreconciled(owner, bankAccountId);

    const readOnly = actorWithRole(owner, "READ_ONLY");
    await expect(FuzzyReconciliationService.suggestMatches(readOnly, unreconciled!.id)).rejects.toThrow(
      PermissionDeniedError,
    );
  });
});
