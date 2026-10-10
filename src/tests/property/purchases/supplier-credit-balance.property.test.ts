import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { SupplierCreditService } from "@/domain/purchases/supplier-credit-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";
import type { CreateSupplierCreditInput } from "@/domain/purchases/types";

/**
 * A supplier credit note posts the mirror image of a bill (credit
 * expense/asset + tax input-credit, debit AP) via the same
 * `PostingService.postJournal` path — so it inherits the same balance
 * invariant a bill's posting does, no matter how many lines/tax mixes it has.
 */
function creditArbitrary(expenseAccountIds: string[], taxCodeId: string, supplierContactId: string, apAccountId: string) {
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
      (rows): CreateSupplierCreditInput => ({
        supplierContactId,
        issueDate: new Date("2026-04-01"),
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

describe("Supplier credit note posting balance invariant (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-credit");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("every posted credit note posts a journal where SUM(debit) === SUM(credit)", async () => {
    await fc.assert(
      fc.asyncProperty(
        creditArbitrary(
          [fixtures.expenseAccountId, fixtures.otherExpenseAccountId],
          fixtures.taxCodeId,
          fixtures.supplierContactId,
          fixtures.apAccountId,
        ),
        async (input) => {
          const created = await SupplierCreditService.create(owner, input);
          const posted = await SupplierCreditService.approveAndPost(owner, created.id);
          const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
          if (!entry) return false;

          const totalDebit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.debit, "AUD")), Money.zero("AUD"));
          const totalCredit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.credit, "AUD")), Money.zero("AUD"));
          const credit = await SupplierCreditService.get(owner, created.id);

          return totalDebit.equals(totalCredit) && totalDebit.equals(Money.of(credit!.total, "AUD"));
        },
      ),
      { numRuns: 20 },
    );
  });
});
