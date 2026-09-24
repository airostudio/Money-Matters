import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { QuoteService } from "@/domain/sales/quote-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { Money } from "@/domain/money/money";
import type { Actor } from "@/domain/permissions/permission-service";
import type { CreateQuoteInput } from "@/domain/sales/types";

/**
 * A quote never posts to the ledger itself, but the invoice it converts
 * into goes through the exact same `InvoiceService`/`PostingService` path
 * as a manually created invoice — no parallel posting logic. This proves
 * the balance invariant survives that composition for arbitrary quote
 * shapes: every converted-and-posted invoice's journal balances.
 */
function quoteArbitrary(revenueAccountIds: string[], taxCodeId: string, customerContactId: string) {
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
      (rows): CreateQuoteInput => ({
        customerContactId,
        issueDate: new Date("2026-03-01"),
        expiryDate: new Date("2026-03-31"),
        currency: "AUD",
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

describe("Quote -> invoice conversion balance invariant (property-based)", () => {
  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeAll(async () => {
    await resetDatabase();
    const org = await createTestOrg("prop-quote-convert");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("every accepted quote converts to an invoice whose posted journal balances and matches the quote's own total", async () => {
    await fc.assert(
      fc.asyncProperty(
        quoteArbitrary([fixtures.revenueAccountId, fixtures.otherRevenueAccountId], fixtures.taxCodeId, fixtures.customerContactId),
        async (input) => {
          const quote = await QuoteService.create(owner, input);
          await QuoteService.markSent(owner, quote.id);
          await QuoteService.accept(owner, quote.id);

          const converted = await QuoteService.convertToInvoice(owner, quote.id, {
            issueDate: new Date("2026-04-01"),
            dueDate: new Date("2026-04-30"),
            arAccountId: fixtures.arAccountId,
          });

          const invoice = await InvoiceService.get(owner, converted.invoiceId);
          const quoteAfter = await QuoteService.get(owner, quote.id);
          if (!invoice || !quoteAfter) return false;
          if (invoice.total !== quoteAfter.total) return false;
          if (quoteAfter.status !== "CONVERTED") return false;

          const posted = await InvoiceService.approveAndPost(owner, converted.invoiceId);
          const entry = await LedgerService.getJournalEntry(owner, posted.journalEntryId!);
          if (!entry) return false;

          const totalDebit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.debit, "AUD")), Money.zero("AUD"));
          const totalCredit = entry.lines.reduce((sum, l) => sum.add(Money.of(l.credit, "AUD")), Money.zero("AUD"));

          return totalDebit.equals(totalCredit) && totalDebit.equals(Money.of(invoice.total, "AUD"));
        },
      ),
      { numRuns: 15 },
    );
  });
});
