import { describe, expect, it } from "vitest";
import {
  calendarPeriod,
  canonicalJson,
  classifyLine,
  computeBasFigures,
  contentHash,
  drillDown,
  periodBounds,
  reconcileToControlAccounts,
  type BasSourceLine,
} from "@/domain/tax/bas-calculations";

function line(over: Partial<BasSourceLine>): BasSourceLine {
  return {
    docType: "INVOICE",
    docId: "d1",
    docNumber: "INV-1",
    lineId: "l1",
    lineNumber: 1,
    description: "x",
    side: "SALE",
    sign: 1,
    event: "POSTING",
    postingDate: "2026-07-10",
    journalEntryId: "j1",
    taxCodeId: "tc",
    taxCodeCode: "GST",
    treatment: "TAXABLE",
    capital: false,
    net: "100.0000",
    gst: "10.0000",
    foreignCurrency: false,
    ...over,
  };
}

describe("BAS classification (hand-verified)", () => {
  it("taxable sale: G1 is GST-inclusive, 1A is the GST", () => {
    const c = classifyLine(line({}));
    expect(c.contributions).toEqual({ G1: "110.0000", "1A": "10.0000" });
  });

  it("GST-free sale goes to G1 and G3; export goes to G1 and G2; input-taxed only to G1", () => {
    expect(classifyLine(line({ treatment: "GST_FREE", gst: "0" })).contributions).toEqual({ G1: "100.0000", G3: "100.0000" });
    expect(classifyLine(line({ treatment: "EXPORT", gst: "0" })).contributions).toEqual({ G1: "100.0000", G2: "100.0000" });
    const it = classifyLine(line({ treatment: "INPUT_TAXED", gst: "0" }));
    expect(it.contributions).toEqual({ G1: "100.0000" });
    expect(it.memo).toBe("INPUT_TAXED_SALE");
  });

  it("NOT_REPORTED sales appear in no label", () => {
    const c = classifyLine(line({ treatment: "NOT_REPORTED", gst: "0" }));
    expect(c.contributions).toEqual({});
    expect(c.memo).toBe("NOT_REPORTED");
  });

  it("taxable purchase: capital -> G10, non-capital -> G11, GST -> 1B (all GST-inclusive)", () => {
    expect(classifyLine(line({ side: "PURCHASE", capital: true, net: "2000", gst: "200" })).contributions).toEqual({
      G10: "2200.0000",
      "1B": "200.0000",
    });
    expect(classifyLine(line({ side: "PURCHASE", net: "50", gst: "5" })).contributions).toEqual({
      G11: "55.0000",
      "1B": "5.0000",
    });
  });

  it("non-taxable purchases are disclosed but excluded (placement at G11 is unverified)", () => {
    const c = classifyLine(line({ side: "PURCHASE", treatment: "GST_FREE", gst: "0" }));
    expect(c.contributions).toEqual({});
    expect(c.memo).toBe("OTHER_PURCHASE_EXCLUDED");
  });

  it("refuses to guess: no tax code, unclassified code, foreign currency, GST on a non-taxable code", () => {
    expect(classifyLine(line({ taxCodeId: null, treatment: null })).unclassifiedReason).toBe("NO_TAX_CODE");
    expect(classifyLine(line({ treatment: null })).unclassifiedReason).toBe("TAX_CODE_UNCLASSIFIED");
    expect(classifyLine(line({ foreignCurrency: true })).unclassifiedReason).toBe("FOREIGN_CURRENCY");
    expect(classifyLine(line({ treatment: "GST_FREE", gst: "1.0000" })).unclassifiedReason).toBe("GST_ON_NON_TAXABLE_CODE");
  });

  it("a reversal (sign -1) exactly negates its posting", () => {
    const post = classifyLine(line({}));
    const rev = classifyLine(line({ sign: -1, event: "REVERSAL" }));
    const f = computeBasFigures([post, rev], []);
    expect(f.labels.G1).toBe("0.0000");
    expect(f.labels["1A"]).toBe("0.0000");
  });
});

describe("computeBasFigures", () => {
  it("sums a mixed quarter to independently computed totals", () => {
    // Independent expected values (worked by hand):
    //  sales:   A 1000 + 100 GST (taxable) ; B 500 GST-free ; C 2000 export ; D 300 input-taxed ; E 40 + 4 GST (taxable)
    //  G1 = 1100 + 500 + 2000 + 300 + 44 = 3944 ; G2 = 2000 ; G3 = 500 ; 1A = 104
    //  purchases: P 400 + 40 (non-capital) ; Q 3000 + 300 (capital) ; R 90 GST-free (excluded) ; credit note: -80 - 8 non-capital
    //  G11 = 440 - 88 = 352 ; G10 = 3300 ; 1B = 40 + 300 - 8 = 332
    //  payroll: gross 5000.00 + 2500.50 ; payg 900 + 410.25  => W1 7500.50, W2 1310.25
    const lines = [
      line({ lineId: "A", net: "1000", gst: "100" }),
      line({ lineId: "B", treatment: "GST_FREE", net: "500", gst: "0" }),
      line({ lineId: "C", treatment: "EXPORT", net: "2000", gst: "0" }),
      line({ lineId: "D", treatment: "INPUT_TAXED", net: "300", gst: "0" }),
      line({ lineId: "E", net: "40", gst: "4" }),
      line({ lineId: "P", side: "PURCHASE", docType: "BILL", net: "400", gst: "40" }),
      line({ lineId: "Q", side: "PURCHASE", docType: "BILL", capital: true, net: "3000", gst: "300" }),
      line({ lineId: "R", side: "PURCHASE", docType: "BILL", treatment: "GST_FREE", net: "90", gst: "0" }),
      line({ lineId: "S", side: "PURCHASE", docType: "SUPPLIER_CREDIT", sign: -1, net: "80", gst: "8" }),
    ].map(classifyLine);
    const f = computeBasFigures(lines, [
      { payRunId: "r1", payDate: "2026-07-14", periodStart: "2026-07-01", periodEnd: "2026-07-14", event: "POSTING", sign: 1, gross: "5000.0000", payg: "900.0000" },
      { payRunId: "r2", payDate: "2026-07-28", periodStart: "2026-07-15", periodEnd: "2026-07-28", event: "POSTING", sign: 1, gross: "2500.5000", payg: "410.2500" },
    ]);
    expect(f.labels).toEqual({
      G1: "3944.0000",
      G2: "2000.0000",
      G3: "500.0000",
      G10: "3300.0000",
      G11: "352.0000",
      "1A": "104.0000",
      "1B": "332.0000",
      W1: "7500.5000",
      W2: "1310.2500",
    });
    expect(f.netGst).toBe("-228.0000");
    expect(f.netGstPlusPaygWithheld).toBe("1082.2500");
    expect(f.memo.inputTaxedSalesInG1).toBe("300.0000");
    expect(f.memo.otherPurchasesExcluded).toBe("90.0000");
  });

  it("keeps unclassified amounts out of every label and counts them", () => {
    const lines = [
      line({ lineId: "A", net: "100", gst: "10" }),
      line({ lineId: "B", taxCodeId: null, treatment: null, net: "999", gst: "0" }),
    ].map(classifyLine);
    const f = computeBasFigures(lines, []);
    expect(f.labels.G1).toBe("110.0000");
    expect(f.unclassified.sales).toEqual({ count: 1, net: "999.0000", gst: "0.0000" });
    expect(f.unclassified.byReason).toEqual({ NO_TAX_CODE: 1 });
  });

  it("every label equals the sum of its drill-down contributions", () => {
    const lines = [
      line({ lineId: "A", net: "1000.3333", gst: "100.0333" }),
      line({ lineId: "B", net: "12.5", gst: "1.25" }),
      line({ lineId: "C", side: "PURCHASE", net: "77.77", gst: "7.78", capital: true }),
    ].map(classifyLine);
    const f = computeBasFigures(lines, []);
    for (const label of ["G1", "1A", "G10", "1B"] as const) {
      const sum = drillDown(lines, label).reduce((s, d) => s + Number(d.amount), 0);
      expect(sum.toFixed(4)).toBe(Number(f.labels[label]).toFixed(4));
    }
  });
});

describe("reconcileToControlAccounts", () => {
  it("shows the variance and never plugs it", () => {
    const f = computeBasFigures([classifyLine(line({})), classifyLine(line({ side: "PURCHASE", net: "50", gst: "5" }))], []);
    const r = reconcileToControlAccounts(
      [
        { accountId: "a", code: "2100", name: "GST Payable", role: "SALES_GST", debit: "0", credit: "12.0000" },
        { accountId: "b", code: "1300", name: "GST Receivable", role: "PURCHASES_GST", debit: "5.0000", credit: "0" },
      ],
      f,
    );
    expect(r.ledgerGstOnSales).toBe("12.0000");
    expect(r.ledgerGstOnPurchases).toBe("5.0000");
    expect(r.salesVariance).toBe("2.0000"); // ledger 12 vs BAS 10
    expect(r.purchasesVariance).toBe("0.0000");
    expect(r.variance).toBe("2.0000");
    expect(r.basNet).toBe("5.0000");
    expect(r.ledgerNet).toBe("7.0000");
  });
});

describe("content hash and periods", () => {
  it("is order-independent for object keys and changes with any figure", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const h1 = contentHash({ a: "1.0000", b: "2.0000" });
    expect(contentHash({ b: "2.0000", a: "1.0000" })).toBe(h1);
    expect(contentHash({ a: "1.0001", b: "2.0000" })).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calendar periods and inclusive bounds", () => {
    expect(calendarPeriod("QUARTERLY", 2026, 1)).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(calendarPeriod("QUARTERLY", 2026, 4)).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(calendarPeriod("MONTHLY", 2028, 2)).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    const { from, to } = periodBounds("2026-07-01", "2026-07-31");
    expect(from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });
});
