import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { BillService } from "@/domain/purchases/bill-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";
import type { CreateBillInput } from "@/domain/purchases/types";

/**
 * Master spec AP invariant, mirroring
 * src/tests/property/sales/invoice-posting-balance.property.test.ts: an
 * approved/posted bill's journal always balances (debits === credits) no
 * matter how many lines, accounts, or tax codes it mixes — because
 * BillService.approveAndPost never writes journal_lines directly, only
 * through PostingService, which itself enforces this.
 */
function billArbitrary(expenseAccountIds: string[], taxCodeId: string, supplierContactId: string, apAccountId: string) {
  return fc
    .array(
      fc.record({
        quantity: fc.integer({ min: 1, max: 20 }),
        unitPriceCents: fc.integer({ min: 1, max: 100_000 }),
        accountIdx: fc.integer({ min: 0, max: expenseAccountIds.length - 1 }),
        taxed: fc.boolean(),
      }),
      { minLength: 1, maxLength: 6 },
    )
    .map(
      (rows): CreateBillInput => ({
        supplierContactId,
        issueDate: new Date("2026-03-01"),
        dueDate: new Date("2026-03-31"),
        currency: "AUD",
        apAccountId,
        lines: rows.map((r, i) => ({
          description: `Line ${i + 1}`,
          quantity: String(r.quantity),
          unitPrice: (r.unitPriceCents / 100).toFixed(2),
          accountId: expenseAccountIds[r.accountIdx]!,
          taxCodeId: r.taxed ? taxCodeId : undefined,
        })),
      }),
    );
}

describe("Bill posting balance invariant (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-bill");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("every approved bill posts a journal where SUM(debit) === SUM(credit)", async () => {
    await fc.assert(
      fc.asyncProperty(
        billArbitrary(
          [fixtures.expenseAccountId, fixtures.otherExpenseAccountId],
          fixtures.taxCodeId,
          fixtures.supplierContactId,
          fixtures.apAccountId,
        ),
        async (input) => {
          const created = await BillService.create(owner, input);
          const posted = await BillService.approveAndPost(owner, created.id);
          const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
          if (!entry) return false;

          const totalDebit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.debit, "AUD")), Money.zero("AUD"));
          const totalCredit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.credit, "AUD")), Money.zero("AUD"));
          const bill = await BillService.get(owner, created.id);

          return totalDebit.equals(totalCredit) && totalDebit.equals(Money.of(bill!.total, "AUD"));
        },
      ),
      { numRuns: 20 },
    );
  });
});
