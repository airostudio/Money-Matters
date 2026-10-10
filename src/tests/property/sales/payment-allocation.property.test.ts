import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Master spec AR invariant: "payment allocation cannot exceed available
 * payment" and an allocation can never exceed an invoice's outstanding
 * balance. Rather than generating fully-random (often invalid) inputs and
 * asserting rejection — which mostly exercises the same early guard — this
 * generates a single posted invoice of a random total and then a random
 * *allocation attempt* against it, and checks the service's accept/reject
 * decision always matches the arithmetic truth.
 */
describe("Payment allocation invariants (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-payment");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("an allocation is accepted iff it does not exceed both the invoice's outstanding balance and the payment's own amount", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          invoiceTotalCents: fc.integer({ min: 100, max: 100_000 }),
          paymentAmountCents: fc.integer({ min: 1, max: 150_000 }),
          allocationCents: fc.integer({ min: 1, max: 150_000 }),
        }),
        async ({ invoiceTotalCents, paymentAmountCents, allocationCents }) => {
          const invoiceTotal = (invoiceTotalCents / 100).toFixed(2);
          const paymentAmount = (paymentAmountCents / 100).toFixed(2);
          const allocationAmount = (allocationCents / 100).toFixed(2);

          const created = await InvoiceService.create(owner, {
            customerContactId: fixtures.customerContactId,
            issueDate: new Date("2026-04-01"),
            dueDate: new Date("2026-04-30"),
            currency: "AUD",
            arAccountId: fixtures.arAccountId,
            lines: [
              {
                description: "Property test line",
                quantity: "1",
                unitPrice: invoiceTotal,
                accountId: fixtures.revenueAccountId,
              },
            ],
          });
          await InvoiceService.approveAndPost(owner, created.id);

          const shouldSucceed =
            Money.of(allocationAmount, "AUD").compareTo(Money.of(invoiceTotal, "AUD")) <= 0 &&
            Money.of(allocationAmount, "AUD").compareTo(Money.of(paymentAmount, "AUD")) <= 0;

          let succeeded = true;
          try {
            await PaymentAllocationService.recordPayment(owner, {
              customerContactId: fixtures.customerContactId,
              paymentDate: new Date("2026-04-05"),
              amount: paymentAmount,
              currency: "AUD",
              method: "BANK_TRANSFER",
              depositAccountId: fixtures.bankGlAccountId,
              allocations: [{ invoiceId: created.id, amount: allocationAmount }],
            });
          } catch {
            succeeded = false;
          }

          // Clean up so the next run's invoice starts fully unpaid again.
          if (succeeded) {
            await InvoiceService.get(owner, created.id); // no-op read, just for symmetry/documentation
          }

          return succeeded === shouldSucceed;
        },
      ),
      { numRuns: 30 },
    );
  });
});
