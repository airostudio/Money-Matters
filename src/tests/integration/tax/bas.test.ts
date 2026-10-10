import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { createPayrollFixtures } from "../../helpers/payroll";
import { basStatements } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { SupplierCreditService } from "@/domain/purchases/supplier-credit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { BasService } from "@/domain/tax/bas-service";
import { basReportToCsv } from "@/domain/tax/bas-csv";
import { contentHash, drillDown } from "@/domain/tax/bas-calculations";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";

/**
 * Phase 8 Slice 2: BAS preparation, with every expected figure worked out by hand (not read back from the service).
 *
 * Q3 2026 = 2026-07-01 .. 2026-09-30.
 *   Sales in Q3 (posted dates):
 *     INV-A 07-10  1000 + 100 GST (taxable)           G1 1100   1A 100
 *     INV-B 07-20   500 GST-free                      G1  500   G3 500
 *     INV-C 09-30  2000 + 200 GST (taxable, last day) G1 2200   1A 200
 *     INV-D 08-05   400 + 40 GST (taxable; reversed on 10-15, i.e. in Q4)   G1 440  1A 40
 *     (INV-E 06-30 and INV-F 10-01 fall outside Q3.)
 *     => G1 = 1100+500+2200+440 = 4240 ; G3 = 500 ; G2 = 0 ; 1A = 100+200+40 = 340
 *   Purchases in Q3:
 *     BILL-1 08-02  600 + 60 (non-capital)            G11 660   1B 60
 *     BILL-2 08-15 3000 + 300 (capital code)          G10 3300  1B 300
 *     BILL-3 08-20  800 with NO tax code              => unclassified, in no label
 *     CREDIT-1 09-05 100 + 10 (non-capital credit)    G11 -110  1B -10
 *     => G11 = 660-110 = 550 ; G10 = 3300 ; 1B = 60+300-10 = 350
 *   Payroll: one fortnightly run 2026-08-12, $4000.00 gross, $915.3846 PAYG (hand-computed in the pay-run flow test)
 *     => W1 4000 ; W2 915.3846
 *   Net GST = 340 - 350 = -10 (refundable) ; 1A - 1B + W2 = 905.3846
 */
describe("BAS / GST preparation (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let currency: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;
  let gstFreeCodeId: string;
  let capitalCodeId: string;
  let invoiceIds: Record<string, string>;
  let invoiceJournalIds: Record<string, string>;

  async function postInvoice(key: string, date: string, unitPrice: string, taxCodeId?: string) {
    const inv = await InvoiceService.create(owner, {
      customerContactId: sales.customerContactId,
      issueDate: new Date(date),
      dueDate: new Date(date),
      currency,
      arAccountId: sales.arAccountId,
      lines: [{ description: `Sale ${key}`, quantity: "1", unitPrice, accountId: sales.revenueAccountId, taxCodeId }],
    });
    const posted = await InvoiceService.approveAndPost(owner, inv.id);
    invoiceIds[key] = inv.id;
    invoiceJournalIds[key] = posted.journalEntryId;
  }

  async function postBill(date: string, unitPrice: string, taxCodeId?: string) {
    const bill = await BillService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate: new Date(date),
      dueDate: new Date(date),
      currency,
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Purchase", quantity: "1", unitPrice, accountId: purchases.expenseAccountId, taxCodeId }],
    });
    await BillService.approveAndPost(owner, bill.id);
  }

  async function seedQ3() {
    await postInvoice("E", "2026-06-30", "300.00", sales.taxCodeId);
    await postInvoice("A", "2026-07-10", "1000.00", sales.taxCodeId);
    await postInvoice("B", "2026-07-20", "500.00", gstFreeCodeId);
    await postInvoice("D", "2026-08-05", "400.00", sales.taxCodeId);
    await postInvoice("C", "2026-09-30", "2000.00", sales.taxCodeId);
    await postInvoice("F", "2026-10-01", "700.00", sales.taxCodeId);
    await postBill("2026-08-02", "600.00", purchases.taxCodeId);
    await postBill("2026-08-15", "3000.00", capitalCodeId);
    await postBill("2026-08-20", "800.00", undefined);
    const credit = await SupplierCreditService.create(owner, {
      supplierContactId: purchases.supplierContactId,
      issueDate: new Date("2026-09-05"),
      currency,
      apAccountId: purchases.apAccountId,
      lines: [
        { description: "Return", quantity: "1", unitPrice: "100.00", accountId: purchases.expenseAccountId, taxCodeId: purchases.taxCodeId },
      ],
    });
    await SupplierCreditService.approveAndPost(owner, credit.id);
    // Reverse INV-D in Q4 (an explicit date, so the test never depends on today's date).
    await PostingService.reverseEntry(owner, invoiceJournalIds.D!, "Customer cancelled", new Date("2026-10-15"));

    const gl = await createPayrollFixtures(owner, currency);
    const employee = await EmployeeService.create(owner, {
      name: "Alex Salary",
      employmentBasis: "SALARY",
      annualSalary: "104000.00",
      payFrequency: "FORTNIGHTLY",
      taxFreeThresholdClaimed: true,
      startDate: new Date("2026-01-01"),
    });
    const run = await PayRunService.create(
      owner,
      {
        payFrequency: "FORTNIGHTLY",
        periodStart: new Date("2026-07-30"),
        periodEnd: new Date("2026-08-12"),
        payDate: new Date("2026-08-12"),
        employeeIds: [employee.id],
      },
      gl,
    );
    await PayRunService.post(owner, run.id);
  }

  beforeEach(async () => {
    await resetDatabase();
    invoiceIds = {};
    invoiceJournalIds = {};
    const org = await createTestOrg("bas-flow");
    owner = org.owner;
    currency = org.baseCurrency;
    sales = await createSalesFixtures(owner, currency);
    purchases = await createPurchasesFixtures(owner, currency);
    await TaxCodeService.setBasClassification(owner, sales.taxCodeId, { basTreatment: "TAXABLE", basCapital: false });
    await TaxCodeService.setBasClassification(owner, purchases.taxCodeId, { basTreatment: "TAXABLE", basCapital: false });
    gstFreeCodeId = (
      await TaxCodeService.create(owner, {
        code: "FRE",
        name: "GST-free",
        rate: "0.0000",
        jurisdiction: "AU",
        effectiveFrom: new Date("2020-01-01"),
        basTreatment: "GST_FREE",
      })
    ).id;
    capitalCodeId = (
      await TaxCodeService.create(owner, {
        code: "CAP",
        name: "GST on capital",
        rate: "0.1000",
        jurisdiction: "AU",
        effectiveFrom: new Date("2020-01-01"),
        receivableAccountId: purchases.taxReceivableAccountId,
        basTreatment: "TAXABLE",
        basCapital: true,
      })
    ).id;
  });

  it("computes every label for Q3 2026 to independently hand-worked values", async () => {
    await seedQ3();
    const report = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(report.figures.labels).toEqual({
      G1: "4240.0000",
      G2: "0.0000",
      G3: "500.0000",
      G10: "3300.0000",
      G11: "550.0000",
      "1A": "340.0000",
      "1B": "350.0000",
      W1: "4000.0000",
      W2: "915.3846",
    });
    expect(report.figures.netGst).toBe("-10.0000");
    expect(report.figures.netGstPlusPaygWithheld).toBe("905.3846");
    expect(report.figures.unclassified.purchases).toEqual({ count: 1, net: "800.0000", gst: "0.0000" });
    expect(report.figures.unclassified.byReason).toEqual({ NO_TAX_CODE: 1 });

    // Drill-down: every label equals the sum of the lines shown for it.
    for (const label of ["G1", "G3", "G10", "G11", "1A", "1B"] as const) {
      const sum = drillDown(report.sources, label).reduce((s, d) => s + Number(d.amount), 0);
      expect(sum.toFixed(4)).toBe(Number(report.figures.labels[label]).toFixed(4));
    }
    expect(drillDown(report.sources, "1A").map((d) => d.line.docNumber).sort()).toHaveLength(3);

    // Control accounts agree with the BAS (sales GST credits 340; purchases GST net debit 350).
    expect(report.reconciliation.ledgerGstOnSales).toBe("340.0000");
    expect(report.reconciliation.ledgerGstOnPurchases).toBe("350.0000");
    expect(report.reconciliation.variance).toBe("0.0000");
    // Not locked, and one unclassified line: both are warned about.
    expect(report.warnings.some((w) => w.includes("could not be classified"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("not fully closed"))).toBe(true);
  });

  it("a reversal counts as a negative in the period the reversal is dated (Q4), not in the original period", async () => {
    await seedQ3();
    const q4 = await BasService.preview(owner, { periodStart: "2026-10-01", periodEnd: "2026-10-31", frequency: "MONTHLY" });
    // INV-F 700 + 70 (10-01) and the reversal of INV-D (-440, -40) on 10-15.
    expect(q4.figures.labels.G1).toBe("330.0000");
    expect(q4.figures.labels["1A"]).toBe("30.0000");
    expect(q4.sources.filter((s) => s.event === "REVERSAL")).toHaveLength(1);
  });

  it("reconciliation shows a manual-journal variance and lists the journal, never plugging it", async () => {
    await seedQ3();
    const other = await AccountService.create(owner, { code: "ADJ-1", name: "Adjustment", type: "EXPENSE", currency });
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-08-31"),
      memo: "Manual GST adjustment",
      lines: [
        { accountId: sales.taxPayableAccountId, debit: "5.00", currency },
        { accountId: other.id, credit: "5.00", currency },
      ],
    });
    const report = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(report.reconciliation.ledgerGstOnSales).toBe("335.0000");
    expect(report.reconciliation.salesVariance).toBe("-5.0000");
    expect(report.reconciliation.variance).toBe("-5.0000");
    expect(report.figures.labels["1A"]).toBe("340.0000"); // the BAS figure is unchanged
    expect(report.nonDocumentControlLines).toHaveLength(1);
    expect(report.nonDocumentControlLines[0]!.memo).toBe("Manual GST adjustment");
  });

  it("an unclassified tax code is excluded and reported; classifying it afterwards includes it in a new computation", async () => {
    const unclassified = await TaxCodeService.create(owner, {
      code: "UNC",
      name: "Unclassified 10%",
      rate: "0.1000",
      jurisdiction: "AU",
      effectiveFrom: new Date("2020-01-01"),
      payableAccountId: sales.taxPayableAccountId,
    });
    await postInvoice("U", "2026-07-15", "100.00", unclassified.id);
    let report = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(report.figures.labels.G1).toBe("0.0000");
    expect(report.figures.unclassified.sales.count).toBe(1);
    expect(report.figures.unclassified.byReason).toEqual({ TAX_CODE_UNCLASSIFIED: 1 });
    await TaxCodeService.setBasClassification(owner, unclassified.id, { basTreatment: "TAXABLE", basCapital: false });
    report = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(report.figures.labels.G1).toBe("110.0000");
    expect(report.figures.labels["1A"]).toBe("10.0000");
  });

  it("tax-coded bank journal lines (no GST split in the ledger) are disclosed and not guessed at", async () => {
    const bank = sales.bankGlAccountId;
    const expense = purchases.expenseAccountId;
    await PostingService.postJournal(owner, {
      postingDate: new Date("2026-08-10"),
      memo: "Bank spend coded with GST",
      sourceType: "BANK_TRANSACTION",
      lines: [
        { accountId: expense, debit: "110.00", currency, taxCodeId: purchases.taxCodeId },
        { accountId: bank, credit: "110.00", currency },
      ],
    });
    const report = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(report.figures.labels["1B"]).toBe("0.0000");
    expect(report.adHocTaxCodedLines.count).toBe(1);
    expect(report.adHocTaxCodedLines.totalAmount).toBe("110.0000");
    expect(report.warnings.some((w) => w.includes("without a GST split"))).toBe(true);
  });

  it("lifecycle: warnings must be acknowledged; finalise snapshots with a verifiable hash; the row is then immutable", async () => {
    await seedQ3();
    const draft = await BasService.createDraft(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    await expect(BasService.finalise(owner, draft.id)).rejects.toThrow(/acknowledged/);

    const finalised = await BasService.finalise(owner, draft.id, { acknowledgeWarnings: true });
    expect(finalised.status).toBe("FINALISED");
    expect(finalised.warningsAcknowledged).toBe(true);
    expect(finalised.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const view = await BasService.get(owner, draft.id);
    expect(view.hashVerified).toBe(true);
    expect(contentHash(view.report)).toBe(finalised.contentHash);
    expect(view.liveDrift).toEqual([]);
    expect(view.report.figures.labels["1A"]).toBe("340.0000");

    // The ledger changes after finalising: the snapshot does not, and the drift is reported.
    await postInvoice("G", "2026-09-01", "100.00", sales.taxCodeId);
    const after = await BasService.get(owner, draft.id);
    expect(after.report.figures.labels["1A"]).toBe("340.0000");
    expect(after.hashVerified).toBe(true);
    expect(after.liveDrift!.map((d) => d.label).sort()).toEqual(["1A", "G1"]);
    expect(after.liveDrift!.find((d) => d.label === "1A")).toMatchObject({ snapshot: "340.0000", live: "350.0000" });

    // Service-level and DB-level immutability.
    await expect(BasService.finalise(owner, draft.id, { acknowledgeWarnings: true })).rejects.toThrow(/not a DRAFT/);
    await expect(BasService.deleteDraft(owner, draft.id)).rejects.toThrow(/not a DRAFT/);
    const updated = await withTenant(owner.organizationId, (tx) =>
      tx.update(basStatements).set({ note: "tampered" }).where(eq(basStatements.id, draft.id)).returning(),
    );
    expect(updated).toHaveLength(0); // RLS UPDATE policy only matches DRAFT rows
    const deleted = await withTenant(owner.organizationId, (tx) =>
      tx.delete(basStatements).where(and(eq(basStatements.id, draft.id))).returning(),
    );
    expect(deleted).toHaveLength(0);
    const [row] = await withTenant(owner.organizationId, (tx) => tx.select().from(basStatements).where(eq(basStatements.id, draft.id)));
    expect(row!.note).toBeNull();
  });

  it("records a lodgement made outside Money Matters only after finalising (append-only)", async () => {
    const draft = await BasService.createDraft(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    await expect(BasService.markLodgedOutside(owner, draft.id, { lodgedOn: "2026-10-20", reference: "R1" })).rejects.toThrow(/FINALISED/);
    await BasService.finalise(owner, draft.id, { acknowledgeWarnings: true });
    await BasService.markLodgedOutside(owner, draft.id, { lodgedOn: "2026-10-20", reference: "AGENT-REF-1" });
    const view = await BasService.get(owner, draft.id);
    expect(view.lodgements).toHaveLength(1);
    expect(view.lodgements[0]!.reference).toBe("AGENT-REF-1");
    await expect(BasService.markLodgedOutside(owner, draft.id, { lodgedOn: "2026-10-20", reference: " " })).rejects.toThrow();
  });

  it("a period whose months are all locked produces no lock warning", async () => {
    const { PeriodLockService } = await import("@/domain/close/period-lock-service");
    for (const m of ["2026-07", "2026-08", "2026-09"]) {
      await PeriodLockService.raise(owner, m, "ADVISOR_LOCKED", "BAS preparation lock");
    }
    const report = await BasService.preview(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    expect(report.periodLock.allLocked).toBe(true);
    expect(report.warnings.some((w) => w.includes("not fully closed"))).toBe(false);
  });

  it("refuses cash basis and invalid periods (fails closed)", async () => {
    await expect(
      BasService.createDraft(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY", basis: "CASH" }),
    ).rejects.toThrow(/not supported/);
    await expect(BasService.createDraft(owner, { periodStart: "2026-07-01", periodEnd: "2027-09-30", frequency: "QUARTERLY" })).rejects.toThrow(/cannot exceed/);
    await expect(BasService.createDraft(owner, { periodStart: "2026-09-30", periodEnd: "2026-07-01", frequency: "QUARTERLY" })).rejects.toThrow();
  });

  it("permissions: bookkeeper prepares but cannot finalise; read-only and AI/API actors cannot", async () => {
    const bookkeeper = await addTestMember(owner, "BOOKKEEPER");
    const readOnly = await addTestMember(owner, "READ_ONLY");
    const draft = await BasService.createDraft(bookkeeper, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    await expect(BasService.finalise(bookkeeper, draft.id, { acknowledgeWarnings: true })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(BasService.list(readOnly)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(BasService.createDraft(readOnly, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" })).rejects.toBeInstanceOf(PermissionDeniedError);
    for (const type of ["AI", "API", "AUTOMATION", "SYSTEM"] as const) {
      const nonHuman: Actor = { ...actorWithRole(owner, "OWNER"), type };
      await expect(BasService.finalise(nonHuman, draft.id, { acknowledgeWarnings: true })).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    const accountant = actorWithRole(owner, "ACCOUNTANT");
    expect((await BasService.finalise(accountant, draft.id, { acknowledgeWarnings: true })).status).toBe("FINALISED");
  });

  it("AI bas_summary tool: read-only, permission parity, figures only from the prepared worksheet", async () => {
    await seedQ3();
    const { buildControllerTools } = await import("@/domain/ai-controller/controller-tools");
    const { WRITE_TOOL_PERMISSIONS } = await import("@/domain/ai-controller/write-tools");
    const tool = buildControllerTools([]).find((t) => t.name === "bas_summary")!;
    expect(tool.permission).toBe("bas:read");
    expect(Object.keys(WRITE_TOOL_PERMISSIONS).some((n) => /bas/i.test(n))).toBe(false);

    const none = await tool.execute(owner, {});
    expect(none.ok).toBe(false);

    await BasService.createDraft(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    const ok = await tool.execute(owner, {});
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.summary).toContain("G1 Total sales: 4240.0000");
    expect(ok.summary).toContain("NOT lodged with the ATO");
    expect(ok.citation.drillDownHref).toMatch(/^\/accounting\/bas\//);

    for (const role of ["EMPLOYEE", "READ_ONLY", "MANAGER", "PAYROLL_MANAGER"] as const) {
      const denied = await tool.execute(actorWithRole(owner, role), {});
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error).toContain("bas:read");
    }
  });

  it("the CSV export carries the disclaimer, the labels and every source line", async () => {
    await seedQ3();
    const draft = await BasService.createDraft(owner, { periodStart: "2026-07-01", periodEnd: "2026-09-30", frequency: "QUARTERLY" });
    const view = await BasService.get(owner, draft.id);
    const csv = basReportToCsv(view.report, { status: view.statement.status, contentHash: null });
    expect(csv).toContain("NOT a lodged return");
    expect(csv).toContain("G1,Total sales,4240.0000");
    expect(csv).toContain("W2,Amount withheld from payments shown at W1,915.3846");
    expect(csv.split("\r\n").filter((l) => l.startsWith("INVOICE,")).length).toBe(4); // A, B, C, D postings (D's reversal is dated in Q4)
  });
});
