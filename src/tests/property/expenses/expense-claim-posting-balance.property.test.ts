import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createExpenseFixtures } from "../../helpers/expenses";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";
import type { CreateExpenseClaimInput } from "@/domain/expenses/types";

/**
 * Master spec AP-adjacent invariant, mirroring
 * src/tests/property/purchases/bill-posting-balance.property.test.ts: an
 * approved/posted expense claim's journal always balances (debits ===
 * credits) no matter how many lines, accounts, or tax codes it mixes —
 * because ExpenseClaimService.approve never writes journal_lines directly,
 * only through PostingService, which itself enforces this.
 */
function claimArbitrary(expenseAccountIds: string[], taxCodeId: string, payableAccountId: string, employeeUserId: string) {
  return fc
    .array(
      fc.record({
        amountCents: fc.integer({ min: 1, max: 100_000 }),
        accountIdx: fc.integer({ min: 0, max: expenseAccountIds.length - 1 }),
        taxed: fc.boolean(),
      }),
      { minLength: 1, maxLength: 6 },
    )
    .map(
      (rows): CreateExpenseClaimInput => ({
        employeeUserId,
        claimDate: new Date("2026-03-01"),
        description: "Property-based test claim",
        currency: "AUD",
        payableAccountId,
        lines: rows.map((r, i) => ({
          description: `Line ${i + 1}`,
          amount: (r.amountCents / 100).toFixed(2),
          expenseAccountId: expenseAccountIds[r.accountIdx]!,
          taxCodeId: r.taxed ? taxCodeId : undefined,
        })),
      }),
    );
}

describe("Expense claim posting balance invariant (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createExpenseFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-expense");
    owner = org.owner;
    fixtures = await createExpenseFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("every approved expense claim posts a journal where SUM(debit) === SUM(credit)", async () => {
    await fc.assert(
      fc.asyncProperty(
        claimArbitrary(
          [fixtures.expenseAccountId, fixtures.otherExpenseAccountId],
          fixtures.taxCodeId,
          fixtures.payableAccountId,
          owner.userId,
        ),
        async (input) => {
          const created = await ExpenseClaimService.create(owner, input);
          await ExpenseClaimService.submit(owner, created.id);
          const posted = await ExpenseClaimService.approve(owner, created.id);
          const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
          if (!entry) return false;

          const totalDebit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.debit, "AUD")), Money.zero("AUD"));
          const totalCredit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.credit, "AUD")), Money.zero("AUD"));
          const claim = await ExpenseClaimService.get(owner, created.id);

          return totalDebit.equals(totalCredit) && totalDebit.equals(Money.of(claim!.total, "AUD"));
        },
      ),
      { numRuns: 20 },
    );
  });
});
