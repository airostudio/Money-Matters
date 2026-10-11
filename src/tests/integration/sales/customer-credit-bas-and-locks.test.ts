import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { CustomerCreditService } from "@/domain/sales/customer-credit-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { BasService } from "@/domain/tax/bas-service";
import { drillDown } from "@/domain/tax/bas-calculations";
import { FiscalPeriodService } from "@/domain/ledger/fiscal-period-service";
import { PeriodLockService } from "@/domain/close/period-lock-service";
import { PeriodLockedError } from "@/domain/ledger/errors";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Customer credit notes in the BAS, hand-worked. Q3 2026 = 2026-07-01 .. 2026-09-30.
 *
 *   INV-A  07-10  1000 + 100 GST (taxable)        G1 +1100   1A +100
 *   INV-B  07-20   500 GST-free                   G1  +500   G3  +500
 *   CN-1   08-15   200 +  20 GST (taxable)        G1  -220   1A   -20
 *   CN-2   09-01   100 GST-free                   G1  -100   G3  -100
 *   CN-3   10-05   300 +  30 GST (taxable)        outside Q3 (Q4)
 *   CN-4   08-20   draft only                     not posted, so nothing
 *
 *   => G1 = 1100 + 500 - 220 - 100 = 1280 ; G3 = 500 - 100 = 400 ; 1A = 100 - 20 = 80 ; net GST 80.
 *   Ledger: GST payable credited 100, debited 20 => 80 net, so the control-account variance is 0.
 */
describe("Customer credit notes in the BAS and under period locks (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let currency: string;
  let fx: Awaited<ReturnType<typeof createSalesFixtures>>;
  let gstFreeId: string;

  async function invoice(date: string, unitPrice: string, taxCodeId: string) {
    const inv = await InvoiceService.create(owner, {
      customerContactId: fx.customerContactId,
      issueDate: new Date(date),
      dueDate: new Date(date),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "Sale", quantity: "1", unitPrice, accountId: fx.revenueAccountId, taxCodeId }],
    });
    await InvoiceService.approveAndPost(owner, inv.id);
    return inv.id;
  }

  async function credit(date: string, unitPrice: string, taxCodeId: string, post = true) {
    const c = await CustomerCreditService.create(owner, {
      customerContactId: fx.customerContactId,
      issueDate: new Date(date),
      currency,
      arAccountId: fx.arAccountId,
      lines: [{ description: "Credit", quantity: "1", unitPrice, accountId: fx.revenueAccountId, taxCodeId }],
    });
    if (post) await CustomerCreditService.approveAndPost(owner, c.id);
    return c.id;
  }

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("credit-bas");
    owner = org.owner;
    currency = org.baseCurrency;
    fx = await createSalesFixtures(owner, currency);
    await TaxCodeService.setBasClassification(owner, fx.taxCodeId, { basTreatment: "TAXABLE", basCapital: false });
    gstFreeId = (
      await TaxCodeService.create(owner, {
        code: "FRE",
        name: "GST-free",
        rate: "0.0000",
        jurisdiction: "AU",
        effectiveFrom: new Date("2020-01-01"),
        basTreatment: "GST_FREE",
      })
    ).id;
  });

  it("a posted credit note reduces G1, G3 and 1A in the period it is posted, and the control account still reconciles", async () => {
    await invoice("2026-07-10", "1000.00", fx.taxCodeId);
    await invoice("2026-07-20", "500.00", gstFreeId);
    await credit("2026-08-15", "200.00", fx.taxCodeId);
    await credit("2026-09-01", "100.00", gstFreeId);
    await credit("2026-10-05", "300.00", fx.taxCodeId);
    await credit("2026-08-20", "999.00", fx.taxCodeId, false);

    const q3 = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(q3.figures.labels.G1).toBe("1280.0000");
    expect(q3.figures.labels.G3).toBe("400.0000");
    expect(q3.figures.labels["1A"]).toBe("80.0000");
    expect(q3.figures.netGst).toBe("80.0000");
    expect(q3.reconciliation.ledgerGstOnSales).toBe("80.0000");
    expect(q3.reconciliation.variance).toBe("0.0000");

    const lines1A = drillDown(q3.sources, "1A");
    expect(lines1A.map((d) => [d.line.docType, d.line.docNumber, d.amount]).sort()).toEqual([
      ["CUSTOMER_CREDIT", "CN-000001", "-20.0000"],
      ["INVOICE", "INV-000001", "100.0000"],
    ]);

    // Q4 holds only CN-3: -300 net, -30 GST (G1 is GST-inclusive, so -330).
    const q4 = await BasService.preview(owner, { periodStart: "2026-10-01", periodEnd: "2026-12-31", frequency: "QUARTERLY" });
    expect(q4.figures.labels.G1).toBe("-330.0000");
    expect(q4.figures.labels["1A"]).toBe("-30.0000");
    expect(q4.reconciliation.variance).toBe("0.0000");
  });

  it("voiding a credit note counts as a positive reversal in the period the reversal is dated", async () => {
    await invoice("2026-07-10", "1000.00", fx.taxCodeId);
    const id = await credit("2026-08-15", "200.00", fx.taxCodeId);
    await CustomerCreditService.voidCredit(owner, id, "Issued to the wrong customer");
    // The posting (-220 G1, -20 1A) is in Q3; the reversal is dated today, which is after Q3 (void uses today's date).
    const q3 = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(q3.figures.labels.G1).toBe("880.0000");
    expect(q3.figures.labels["1A"]).toBe("80.0000");
    const todayIso = new Date().toISOString().slice(0, 10);
    if (todayIso > "2026-09-30") {
      const month = await BasService.preview(owner, { periodStart: `${todayIso.slice(0, 7)}-01`, periodEnd: `${todayIso.slice(0, 7)}-28`, frequency: "MONTHLY" });
      expect(month.figures.labels.G1).toBe("220.0000");
      expect(month.figures.labels["1A"]).toBe("20.0000");
      const reversals = month.sources.filter((s) => s.docType === "CUSTOMER_CREDIT");
      expect(reversals.map((s) => [s.event, s.sign])).toEqual([["REVERSAL", 1]]);
    }
  });

  describe("period locks behave exactly as they do for invoices", () => {
    async function lockJuly(level: "SOFT_LOCKED" | "HARD_LOCKED") {
      const period = await FiscalPeriodService.create(owner, { label: "2026-07", startDate: new Date("2026-07-01"), endDate: new Date("2026-07-31") });
      await PeriodLockService.raise(owner, { kind: "id", id: period.id }, level);
    }

    it("HARD_LOCKED refuses the post and leaves the credit a draft with no journal", async () => {
      const id = await credit("2026-07-15", "100.00", fx.taxCodeId, false);
      await lockJuly("HARD_LOCKED");
      await expect(CustomerCreditService.approveAndPost(owner, id)).rejects.toBeInstanceOf(PeriodLockedError);
      const after = await CustomerCreditService.get(owner, id);
      expect(after!.status).toBe("DRAFT");
      expect(after!.journalEntryId).toBeNull();
    });

    it("SOFT_LOCKED refuses without a reason and accepts an accountant's override reason", async () => {
      const id = await credit("2026-07-15", "100.00", fx.taxCodeId, false);
      await lockJuly("SOFT_LOCKED");
      const accountant = actorWithRole(owner, "ACCOUNTANT");
      const refused = await CustomerCreditService.approveAndPost(accountant, id).then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(PeriodLockedError);
      expect((refused as PeriodLockedError).canOverrideWithReason).toBe(true);
      expect((await CustomerCreditService.get(owner, id))!.status).toBe("DRAFT");

      await CustomerCreditService.approveAndPost(accountant, id, { lockOverrideReason: "Late credit agreed with the customer" });
      expect((await CustomerCreditService.get(owner, id))!.status).toBe("APPROVED");
    });
  });
});
