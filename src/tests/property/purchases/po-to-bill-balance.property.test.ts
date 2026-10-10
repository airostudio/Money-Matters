import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { BillService } from "@/domain/purchases/bill-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";
import type { CreatePurchaseOrderInput } from "@/domain/purchases/types";

/**
 * A bill generated from a received purchase order — via
 * `PurchaseOrderService.convertToBill`, which itself only ever calls
 * `BillService.create` — must balance exactly the same way a manually
 * created bill does when posted, whether or not the three-way match found a
 * (deliberately introduced) mismatch that the caller acknowledged.
 */
function poArbitrary(expenseAccountIds: string[], taxCodeId: string, supplierContactId: string) {
  return fc
    .array(
      fc.record({
        quantity: fc.integer({ min: 1, max: 20 }),
        unitPriceCents: fc.integer({ min: 1, max: 100_000 }),
        accountIdx: fc.integer({ min: 0, max: expenseAccountIds.length - 1 }),
        taxed: fc.boolean(),
        // A price the bill actually claims — may differ from the PO's own price, exercising the mismatch path.
        billPriceDeltaCents: fc.integer({ min: -500, max: 500 }),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((rows) => ({
      po: {
        supplierContactId,
        issueDate: new Date("2026-05-01"),
        currency: "AUD",
        lines: rows.map((r, i) => ({
          description: `Line ${i + 1}`,
          quantity: String(r.quantity),
          unitPrice: (r.unitPriceCents / 100).toFixed(2),
          accountId: expenseAccountIds[r.accountIdx]!,
          taxCodeId: r.taxed ? taxCodeId : undefined,
        })),
      } satisfies CreatePurchaseOrderInput,
      billPrices: rows.map((r) => Math.max(1, r.unitPriceCents + r.billPriceDeltaCents) / 100),
    }));
}

describe("PO -> bill conversion balance invariant (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-po-bill");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("every bill converted from a fully-received PO posts a balanced journal, mismatch or not", async () => {
    await fc.assert(
      fc.asyncProperty(
        poArbitrary([fixtures.expenseAccountId, fixtures.otherExpenseAccountId], fixtures.taxCodeId, fixtures.supplierContactId),
        async ({ po, billPrices }) => {
          const created = await PurchaseOrderService.create(owner, po);
          await PurchaseOrderService.markSent(owner, created.id);
          const full = await PurchaseOrderService.get(owner, created.id);
          if (!full) return false;

          await PurchaseOrderService.recordReceipt(owner, created.id, {
            receivedDate: new Date("2026-05-05"),
            lines: full.lines.map((l) => ({ purchaseOrderLineId: l.id, quantityReceived: l.quantity })),
          });

          const result = await PurchaseOrderService.convertToBill(owner, created.id, {
            issueDate: new Date("2026-05-06"),
            dueDate: new Date("2026-06-05"),
            apAccountId: fixtures.apAccountId,
            acknowledgeDiscrepancies: true,
            lines: full.lines.map((l, i) => ({
              poLineId: l.id,
              quantity: l.quantity,
              unitPrice: billPrices[i]!.toFixed(2),
            })),
          });

          const posted = await BillService.approveAndPost(owner, result.id);
          const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
          if (!entry) return false;

          const totalDebit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.debit, "AUD")), Money.zero("AUD"));
          const totalCredit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.credit, "AUD")), Money.zero("AUD"));
          const bill = await BillService.get(owner, result.id);

          return totalDebit.equals(totalCredit) && totalDebit.equals(Money.of(bill!.total, "AUD"));
        },
      ),
      { numRuns: 15 },
    );
  });
});
