import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { QuoteService } from "@/domain/sales/quote-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Quotes — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("quotes-flow");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  async function createDraftQuote() {
    return QuoteService.create(owner, {
      customerContactId: fixtures.customerContactId,
      issueDate: new Date("2026-01-01"),
      expiryDate: new Date("2026-01-31"),
      currency: "AUD",
      lines: [
        {
          description: "Design work",
          quantity: "5",
          unitPrice: "200.00",
          accountId: fixtures.revenueAccountId,
          taxCodeId: fixtures.taxCodeId,
        },
      ],
    });
  }

  it("creates a draft quote with correct computed totals and no ledger effect at all", async () => {
    const created = await createDraftQuote();
    const quote = await QuoteService.get(owner, created.id);

    expect(quote!.status).toBe("DRAFT");
    expect(quote!.subtotal).toBe("1000.0000");
    expect(quote!.taxTotal).toBe("100.0000");
    expect(quote!.total).toBe("1100.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const revenue = trialBalance.find((r) => r.accountId === fixtures.revenueAccountId);
    expect(revenue?.balance ?? "0.0000").toBe("0.0000");
  });

  it("walks DRAFT -> SENT -> ACCEPTED -> CONVERTED, producing a draft invoice that then posts and balances", async () => {
    const created = await createDraftQuote();
    await QuoteService.markSent(owner, created.id);
    await QuoteService.accept(owner, created.id);

    const converted = await QuoteService.convertToInvoice(owner, created.id, {
      issueDate: new Date("2026-02-01"),
      dueDate: new Date("2026-03-01"),
      arAccountId: fixtures.arAccountId,
    });

    const quote = await QuoteService.get(owner, created.id);
    expect(quote!.status).toBe("CONVERTED");
    expect(quote!.convertedInvoiceId).toBe(converted.invoiceId);

    const invoice = await InvoiceService.get(owner, converted.invoiceId);
    expect(invoice!.status).toBe("DRAFT");
    expect(invoice!.total).toBe("1100.0000");
    expect(invoice!.customerContactId).toBe(fixtures.customerContactId);
    expect(invoice!.lines).toHaveLength(1);
    expect(invoice!.lines[0]!.description).toBe("Design work");

    const posted = await InvoiceService.approveAndPost(owner, converted.invoiceId);
    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ar = trialBalance.find((r) => r.accountId === fixtures.arAccountId);
    const revenue = trialBalance.find((r) => r.accountId === fixtures.revenueAccountId);
    expect(ar!.balance).toBe("1100.0000");
    expect(revenue!.balance).toBe("1000.0000");
    expect(posted.status).toBe("APPROVED");
  });

  it("supports declining a sent quote with a reason, and it cannot then be converted", async () => {
    const created = await createDraftQuote();
    await QuoteService.markSent(owner, created.id);
    await QuoteService.decline(owner, created.id, "Went with a competitor");

    const quote = await QuoteService.get(owner, created.id);
    expect(quote!.status).toBe("DECLINED");
    expect(quote!.declineReason).toBe("Went with a competitor");

    await expect(
      QuoteService.convertToInvoice(owner, created.id, {
        issueDate: new Date(),
        dueDate: new Date(),
        arAccountId: fixtures.arAccountId,
      }),
    ).rejects.toThrow(/accepted/);
  });

  it("refuses to accept or decline a quote that hasn't been sent", async () => {
    const created = await createDraftQuote();
    await expect(QuoteService.accept(owner, created.id)).rejects.toThrow(/sent/);
    await expect(QuoteService.decline(owner, created.id, "no")).rejects.toThrow(/sent/);
  });

  it("refuses to convert an already-converted quote a second time", async () => {
    const created = await createDraftQuote();
    await QuoteService.markSent(owner, created.id);
    await QuoteService.accept(owner, created.id);
    await QuoteService.convertToInvoice(owner, created.id, {
      issueDate: new Date(),
      dueDate: new Date(),
      arAccountId: fixtures.arAccountId,
    });

    await expect(
      QuoteService.convertToInvoice(owner, created.id, {
        issueDate: new Date(),
        dueDate: new Date(),
        arAccountId: fixtures.arAccountId,
      }),
    ).rejects.toThrow(/already been converted/);
  });

  it("refuses to edit or delete a quote once it's no longer a draft", async () => {
    const created = await createDraftQuote();
    await QuoteService.markSent(owner, created.id);

    await expect(
      QuoteService.update(owner, created.id, {
        customerContactId: fixtures.customerContactId,
        issueDate: new Date(),
        expiryDate: new Date(),
        currency: "AUD",
        lines: [{ description: "x", quantity: "1", unitPrice: "1.00", accountId: fixtures.revenueAccountId }],
      }),
    ).rejects.toThrow();
    await expect(QuoteService.deleteDraft(owner, created.id)).rejects.toThrow();
  });

  it("deletes a draft quote outright", async () => {
    const created = await createDraftQuote();
    await QuoteService.deleteDraft(owner, created.id);
    expect(await QuoteService.get(owner, created.id)).toBeNull();
  });
});
