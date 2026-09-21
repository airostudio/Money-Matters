import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";
import type { CreateInvoiceInput } from "@/domain/sales/types";

/**
 * Master spec AR invariant: an approved/posted invoice's journal always
 * balances (debits === credits) no matter how many lines, accounts, or
 * tax codes it mixes — because InvoiceService.approveAndPost never writes
 * journal_lines directly, only through PostingService, which itself
 * enforces this (see src/tests/property/ledger/balance.property.test.ts).
 * This test proves the composition holds end to end for real invoice data.
 */
function invoiceArbitrary(revenueAccountIds: string[], taxCodeId: string, customerContactId: string, arAccountId: string) {
  return fc
    .array(
      fc.record({
        quantity: fc.integer({ min: 1, max: 20 }),
        unitPriceCents: fc.integer({ min: 1, max: 100_000 }),
        accountIdx: fc.integer({ min: 0, max: revenueAccountIds.length - 1 }),
        taxed: fc.boolean(),
      }),
      { minLength: 1, maxLength: 6 },
    )
    .map(
      (rows): CreateInvoiceInput => ({
        customerContactId,
        issueDate: new Date("2026-03-01"),
        dueDate: new Date("2026-03-31"),
        currency: "AUD",
        arAccountId,
        lines: rows.map((r, i) => ({
          description: `Line ${i + 1}`,
          quantity: String(r.quantity),
          unitPrice: (r.unitPriceCents / 100).toFixed(2),
          accountId: revenueAccountIds[r.accountIdx]!,
          taxCodeId: r.taxed ? taxCodeId : undefined,
        })),
      }),
    );
}

describe("Invoice posting balance invariant (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-invoice");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("every approved invoice posts a journal where SUM(debit) === SUM(credit)", async () => {
    await fc.assert(
      fc.asyncProperty(
        invoiceArbitrary(
          [fixtures.revenueAccountId, fixtures.otherRevenueAccountId],
          fixtures.taxCodeId,
          fixtures.customerContactId,
          fixtures.arAccountId,
        ),
        async (input) => {
          const created = await InvoiceService.create(owner, input);
          const posted = await InvoiceService.approveAndPost(owner, created.id);
          const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
          if (!entry) return false;

          const totalDebit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.debit, "AUD")), Money.zero("AUD"));
          const totalCredit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.credit, "AUD")), Money.zero("AUD"));
          const invoice = await InvoiceService.get(owner, created.id);

          return totalDebit.equals(totalCredit) && totalDebit.equals(Money.of(invoice!.total, "AUD"));
        },
      ),
      { numRuns: 20 },
    );
  });
});
