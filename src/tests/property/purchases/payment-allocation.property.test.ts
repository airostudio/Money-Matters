import { afterAll, beforeAll, describe, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { BillService } from "@/domain/purchases/bill-service";
import { SupplierPaymentAllocationService } from "@/domain/purchases/supplier-payment-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Master spec AP invariant, mirroring
 * src/tests/property/sales/payment-allocation.property.test.ts:
 * "payment allocation cannot exceed available payment" and an allocation
 * can never exceed a bill's outstanding balance. Generates a single posted
 * bill of a random total and then a random *allocation attempt* against it,
 * and checks the service's accept/reject decision always matches the
 * arithmetic truth.
 */
describe("Supplier payment allocation invariants (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-supplier-payment");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("an allocation is accepted iff it does not exceed both the bill's outstanding balance and the payment's own amount", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          billTotalCents: fc.integer({ min: 100, max: 100_000 }),
          paymentAmountCents: fc.integer({ min: 1, max: 150_000 }),
          allocationCents: fc.integer({ min: 1, max: 150_000 }),
        }),
        async ({ billTotalCents, paymentAmountCents, allocationCents }) => {
          const billTotal = (billTotalCents / 100).toFixed(2);
          const paymentAmount = (paymentAmountCents / 100).toFixed(2);
          const allocationAmount = (allocationCents / 100).toFixed(2);

          const created = await BillService.create(owner, {
            supplierContactId: fixtures.supplierContactId,
            issueDate: new Date("2026-04-01"),
            dueDate: new Date("2026-04-30"),
            currency: "AUD",
            apAccountId: fixtures.apAccountId,
            lines: [
              {
                description: "Property test line",
                quantity: "1",
                unitPrice: billTotal,
                accountId: fixtures.expenseAccountId,
              },
            ],
          });
          await BillService.approveAndPost(owner, created.id);

          const shouldSucceed =
            Money.of(allocationAmount, "AUD").compareTo(Money.of(billTotal, "AUD")) <= 0 &&
            Money.of(allocationAmount, "AUD").compareTo(Money.of(paymentAmount, "AUD")) <= 0;

          let succeeded = true;
          try {
            await SupplierPaymentAllocationService.recordPayment(owner, {
              supplierContactId: fixtures.supplierContactId,
              paymentDate: new Date("2026-04-05"),
              amount: paymentAmount,
              currency: "AUD",
              method: "BANK_TRANSFER",
              paymentAccountId: fixtures.bankGlAccountId,
              allocations: [{ billId: created.id, amount: allocationAmount }],
            });
          } catch {
            succeeded = false;
          }

          return succeeded === shouldSucceed;
        },
      ),
      { numRuns: 30 },
    );
  });
});
