import { afterAll, beforeEach, describe, it, expect } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { AccountService } from "@/domain/accounts/account-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * The double-entry invariant already proven at the posting layer
 * (`src/tests/property/ledger/*` — every posted journal's debits equal its
 * credits) implies a stronger statement one layer up: for ANY set of posted,
 * balanced journal entries, `Assets = Liabilities + Equity` on the Balance
 * Sheet — the extended accounting equation, with Revenue/Expense activity
 * folded into the computed "Current Year Earnings" equity line (see
 * `buildBalanceSheet`'s doc comment). This test proves that end-to-end
 * through the real `ReportingService.getBalanceSheet` against a real
 * Postgres instance, for arbitrary random balanced entries touching a mix
 * of ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE accounts — real regression
 * protection for the reporting layer, not just the ledger layer.
 */
describe("Balance Sheet invariant (property-based)", () => {
  let owner: Actor;
  let accountIds: { bank: string; ar: string; ap: string; capital: string; sales: string; rent: string };

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("bs-invariant");
    owner = org.owner;

    const [bank, ar, ap, capital, sales, rent] = await Promise.all([
      AccountService.create(owner, { code: "1500", name: "Bank", type: "ASSET", currency: org.baseCurrency }),
      AccountService.create(owner, {
        code: "1600",
        name: "Accounts Receivable",
        type: "ASSET",
        currency: org.baseCurrency,
      }),
      AccountService.create(owner, {
        code: "2500",
        name: "Accounts Payable",
        type: "LIABILITY",
        currency: org.baseCurrency,
      }),
      AccountService.create(owner, {
        code: "3500",
        name: "Owner's Capital",
        type: "EQUITY",
        currency: org.baseCurrency,
      }),
      AccountService.create(owner, { code: "4500", name: "Sales", type: "REVENUE", currency: org.baseCurrency }),
      AccountService.create(owner, { code: "6500", name: "Rent", type: "EXPENSE", currency: org.baseCurrency }),
    ]);
    accountIds = { bank: bank.id, ar: ar.id, ap: ap.id, capital: capital.id, sales: sales.id, rent: rent.id };
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("Assets always equal Liabilities + Equity after any sequence of balanced postings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            debitIdx: fc.integer({ min: 0, max: 5 }),
            creditIdx: fc.integer({ min: 0, max: 5 }),
            amountCents: fc.integer({ min: 1, max: 500_000 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (entries) => {
          const accountList = [
            accountIds.bank,
            accountIds.ar,
            accountIds.ap,
            accountIds.capital,
            accountIds.sales,
            accountIds.rent,
          ];

          for (const [i, e] of entries.entries()) {
            const amount = (e.amountCents / 100).toFixed(2);
            await PostingService.postJournal(owner, {
              postingDate: new Date("2026-03-01"),
              memo: `Property test entry ${i}`,
              lines: [
                { accountId: accountList[e.debitIdx]!, debit: amount, currency: "AUD" },
                { accountId: accountList[e.creditIdx]!, credit: amount, currency: "AUD" },
              ],
            });
          }

          const balanceSheet = await ReportingService.getBalanceSheet(owner, new Date("2026-12-31"));
          expect(balanceSheet.isBalanced).toBe(true);
          expect(balanceSheet.difference).toBe("0.0000");
        },
      ),
      { numRuns: 10 },
    );
  }, 60_000);
});
