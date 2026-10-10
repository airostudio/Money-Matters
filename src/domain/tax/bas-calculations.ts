import Decimal from "decimal.js";
import { createHash } from "node:crypto";

/**
 * Pure, DB-free BAS (Business Activity Statement) arithmetic - Phase 8 Slice 2.
 *
 * PREPARATION ONLY. Everything here requires registered tax agent / BAS agent review and is NOT lodged with the ATO.
 *
 * Labels implemented (each cross-confirmed from at least two independent sources - see BAS_LABEL_SOURCES and
 * docs/roadmap.md, Phase 8 "verified figures"):
 *   G1  Total sales (includes GST-free and input-taxed sales, and GST)
 *   G2  Export sales            (reported within G1)
 *   G3  Other GST-free sales    (reported within G1)
 *   G10 Capital purchases       (GST-inclusive)
 *   G11 Non-capital purchases   (GST-inclusive)
 *   1A  GST on sales
 *   1B  GST on purchases (GST credits)
 *   W1  Total salary, wages and other payments (gross)
 *   W2  Amount withheld from payments shown at W1
 *
 * Labels deliberately NOT implemented because they could not be cross-confirmed: 8A / 8B / 9 (summary and payment
 * section; sources conflict on where the PAYG total flows), G4 / G13 / G14 / G15 (worksheet-only), 5A / 5B / 7 (PAYG
 * instalments / fuel tax - out of scope), W3 / W4 / W5. Where a purchase cannot be placed at G10/G11 with confidence
 * (GST-free / input-taxed / not-reported purchases) it is listed as a memo and EXCLUDED, never approximated.
 *
 * Nothing is rounded here: every figure is the exact sum of the 4-dp ledger amounts. Whether and how whole-dollar
 * rounding applies on the lodged form is a matter for the preparing agent.
 */

export const BAS_BASIS_SUPPORTED = "ACCRUAL" as const;

export type BasGstTreatment = "TAXABLE" | "GST_FREE" | "EXPORT" | "INPUT_TAXED" | "NOT_REPORTED";
export type BasDocType = "INVOICE" | "BILL" | "SUPPLIER_CREDIT" | "EXPENSE_CLAIM";
export type BasLabel = "G1" | "G2" | "G3" | "G10" | "G11" | "1A" | "1B" | "W1" | "W2";
export const BAS_LABELS: readonly BasLabel[] = ["G1", "G2", "G3", "G10", "G11", "1A", "1B", "W1", "W2"];

export const BAS_LABEL_TITLES: Record<BasLabel, string> = {
  G1: "Total sales",
  G2: "Export sales",
  G3: "Other GST-free sales",
  G10: "Capital purchases",
  G11: "Non-capital purchases",
  "1A": "GST on sales",
  "1B": "GST on purchases",
  W1: "Total salary, wages and other payments",
  W2: "Amount withheld from payments shown at W1",
};

export const BAS_DISCLAIMER =
  "Prepared by Money Matters for review by a registered tax agent or BAS agent. This is NOT a lodged return: nothing " +
  "has been (or can be) transmitted to the ATO from here. Figures are derived only from posted ledger data and tax " +
  "codes classified in Money Matters; unclassified items are listed separately and are not included.";

/** Source citations for the label definitions (recorded in docs/roadmap.md and shown on the report page). */
export const BAS_LABEL_SOURCES: Record<string, string> = {
  "G1/G2/G3/1A/1B":
    "ATO 'Business activity statements (BAS)' and 'Completing your BAS for GST' (Step 1: Sales); corroborated by Smart Biz Australia and paygcalculator.au BAS label guides. ATO: GST-free and input-taxed sales are reported at G1; amounts at G2 and G3 are also reported at G1.",
  "G10/G11":
    "ATO 'Completing your BAS for GST' (Step 3: Purchases): G10 capital purchases (machinery, equipment, cars, computers), G11 non-capital (trading stock, running expenses); amounts reported at G10 and G11 include GST; corroborated by geekbooks.com.au and myaccountant Help Centre.",
  "W1/W2":
    "ATO 'Pay as you go (PAYG) withholding' and 'ATO PAYG withholding pre-fill for activity statements' (W1 total gross salary, wages and other payments; W2 amounts withheld from payments shown at W1); corroborated by itp.com.au and jtwaccountants.com.au.",
  "GST rate / concepts":
    "GST is 10% of the GST-exclusive price (one-eleventh of the GST-inclusive price); GST-free sales still carry credits for related purchases, input-taxed sales do not (ATO 'Input-taxed sales'; bristax.com.au; emumoney.com.au). The 10% rate itself is NOT hardcoded: each tax code carries its own rate.",
};

export interface BasSourceLine {
  docType: BasDocType;
  docId: string;
  docNumber: string;
  lineId: string;
  lineNumber: number;
  description: string;
  side: "SALE" | "PURCHASE";
  /** +1 normal, -1 for a supplier credit note and/or a reversal (void) event. */
  sign: 1 | -1;
  event: "POSTING" | "REVERSAL";
  /** The posting date of the journal that carries this event (YYYY-MM-DD). */
  postingDate: string;
  journalEntryId: string;
  taxCodeId: string | null;
  taxCodeCode: string | null;
  treatment: BasGstTreatment | null;
  capital: boolean;
  /** Unsigned, as stored on the document line (GST-exclusive). */
  net: string;
  /** Unsigned GST as stored on the document line. */
  gst: string;
  /** True when the document currency is not the organisation's base currency. */
  foreignCurrency: boolean;
}

export type UnclassifiedReason =
  | "NO_TAX_CODE"
  | "TAX_CODE_UNCLASSIFIED"
  | "FOREIGN_CURRENCY"
  | "GST_ON_NON_TAXABLE_CODE";

export interface ClassifiedSourceLine extends BasSourceLine {
  /** Signed contribution of this line to each label (only labels it touches). */
  contributions: Partial<Record<BasLabel, string>>;
  /** Set when the line is excluded from every label. */
  unclassifiedReason?: UnclassifiedReason;
  /** Set for lines deliberately excluded from labels but disclosed (purchases not placed at G10/G11, NOT_REPORTED sales). */
  memo?: "INPUT_TAXED_SALE" | "OTHER_PURCHASE_EXCLUDED" | "NOT_REPORTED";
}

export interface PayrollSourceLine {
  payRunId: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  event: "POSTING" | "REVERSAL";
  sign: 1 | -1;
  gross: string;
  payg: string;
}

export interface BasFigures {
  labels: Record<BasLabel, string>;
  /** 1A - 1B. Positive = GST payable, negative = GST refundable. */
  netGst: string;
  /** Money Matters summary, NOT an ATO label: 1A - 1B + W2. */
  netGstPlusPaygWithheld: string;
  memo: {
    /** Input-taxed sales included in G1 (net). */
    inputTaxedSalesInG1: string;
    /** Purchases under GST-free / input-taxed / export / not-reported codes: excluded from G10/G11 (placement unverified). */
    otherPurchasesExcluded: string;
    /** Sales under NOT_REPORTED codes: excluded from every label. */
    notReportedSales: string;
  };
  unclassified: {
    sales: { count: number; net: string; gst: string };
    purchases: { count: number; net: string; gst: string };
    byReason: Record<string, number>;
  };
}

const ZERO = new Decimal(0);

function dec(v: string): Decimal {
  return new Decimal(v);
}

function fixed(v: Decimal): string {
  return v.toFixed(4);
}

/** Classifies one source line into its signed label contributions, or marks it unclassified. Pure. */
export function classifyLine(line: BasSourceLine): ClassifiedSourceLine {
  const sign = new Decimal(line.sign);
  const net = dec(line.net).times(sign);
  const gst = dec(line.gst).times(sign);
  const gross = net.plus(gst);
  const out: ClassifiedSourceLine = { ...line, contributions: {} };

  if (line.foreignCurrency) return { ...out, unclassifiedReason: "FOREIGN_CURRENCY" };
  if (!line.taxCodeId) return { ...out, unclassifiedReason: "NO_TAX_CODE" };
  if (!line.treatment) return { ...out, unclassifiedReason: "TAX_CODE_UNCLASSIFIED" };
  if (line.treatment !== "TAXABLE" && !dec(line.gst).isZero()) {
    return { ...out, unclassifiedReason: "GST_ON_NON_TAXABLE_CODE" };
  }

  const c = out.contributions;
  if (line.side === "SALE") {
    switch (line.treatment) {
      case "TAXABLE":
        c.G1 = fixed(gross);
        c["1A"] = fixed(gst);
        break;
      case "GST_FREE":
        c.G1 = fixed(gross);
        c.G3 = fixed(net);
        break;
      case "EXPORT":
        c.G1 = fixed(gross);
        c.G2 = fixed(net);
        break;
      case "INPUT_TAXED":
        c.G1 = fixed(gross);
        out.memo = "INPUT_TAXED_SALE";
        break;
      case "NOT_REPORTED":
        out.memo = "NOT_REPORTED";
        break;
    }
  } else {
    if (line.treatment === "TAXABLE") {
      c[line.capital ? "G10" : "G11"] = fixed(gross);
      c["1B"] = fixed(gst);
    } else {
      out.memo = "OTHER_PURCHASE_EXCLUDED";
    }
  }
  return out;
}

export function computeBasFigures(lines: ClassifiedSourceLine[], payroll: PayrollSourceLine[]): BasFigures {
  const totals: Record<BasLabel, Decimal> = {
    G1: ZERO,
    G2: ZERO,
    G3: ZERO,
    G10: ZERO,
    G11: ZERO,
    "1A": ZERO,
    "1B": ZERO,
    W1: ZERO,
    W2: ZERO,
  };
  let inputTaxed = ZERO;
  let otherPurchases = ZERO;
  let notReported = ZERO;
  const unclassified = {
    sales: { count: 0, net: ZERO, gst: ZERO },
    purchases: { count: 0, net: ZERO, gst: ZERO },
    byReason: {} as Record<string, number>,
  };

  for (const line of lines) {
    const sign = new Decimal(line.sign);
    const net = dec(line.net).times(sign);
    const gst = dec(line.gst).times(sign);
    if (line.unclassifiedReason) {
      const bucket = line.side === "SALE" ? unclassified.sales : unclassified.purchases;
      bucket.count += 1;
      bucket.net = bucket.net.plus(net);
      bucket.gst = bucket.gst.plus(gst);
      unclassified.byReason[line.unclassifiedReason] = (unclassified.byReason[line.unclassifiedReason] ?? 0) + 1;
      continue;
    }
    for (const label of BAS_LABELS) {
      const v = line.contributions[label];
      if (v !== undefined) totals[label] = totals[label].plus(v);
    }
    if (line.memo === "INPUT_TAXED_SALE") inputTaxed = inputTaxed.plus(net);
    if (line.memo === "OTHER_PURCHASE_EXCLUDED") otherPurchases = otherPurchases.plus(net);
    if (line.memo === "NOT_REPORTED") notReported = notReported.plus(net);
  }

  for (const p of payroll) {
    const sign = new Decimal(p.sign);
    totals.W1 = totals.W1.plus(dec(p.gross).times(sign));
    totals.W2 = totals.W2.plus(dec(p.payg).times(sign));
  }

  const netGst = totals["1A"].minus(totals["1B"]);
  const labels = Object.fromEntries(BAS_LABELS.map((l) => [l, fixed(totals[l])])) as Record<BasLabel, string>;
  return {
    labels,
    netGst: fixed(netGst),
    netGstPlusPaygWithheld: fixed(netGst.plus(totals.W2)),
    memo: {
      inputTaxedSalesInG1: fixed(inputTaxed),
      otherPurchasesExcluded: fixed(otherPurchases),
      notReportedSales: fixed(notReported),
    },
    unclassified: {
      sales: { count: unclassified.sales.count, net: fixed(unclassified.sales.net), gst: fixed(unclassified.sales.gst) },
      purchases: {
        count: unclassified.purchases.count,
        net: fixed(unclassified.purchases.net),
        gst: fixed(unclassified.purchases.gst),
      },
      byReason: unclassified.byReason,
    },
  };
}

/** Source lines contributing to a label, with the signed contribution (drill-down). */
export function drillDown(lines: ClassifiedSourceLine[], label: BasLabel): Array<{ line: ClassifiedSourceLine; amount: string }> {
  return lines
    .filter((l) => l.contributions[label] !== undefined && !l.unclassifiedReason)
    .map((l) => ({ line: l, amount: l.contributions[label]! }));
}

export function payrollDrillDown(payroll: PayrollSourceLine[], label: "W1" | "W2") {
  return payroll.map((p) => ({
    payroll: p,
    amount: fixed(dec(label === "W1" ? p.gross : p.payg).times(p.sign)),
  }));
}

// ---------------------------------------------------------------------------
// Reconciliation to the GST control accounts
// ---------------------------------------------------------------------------

export interface ControlAccountActivity {
  accountId: string;
  code: string;
  name: string;
  role: "SALES_GST" | "PURCHASES_GST";
  /** Period debits / credits in the base currency (journal lines of posted entries dated inside the period). */
  debit: string;
  credit: string;
}

export interface BasReconciliation {
  accounts: Array<ControlAccountActivity & { movement: string }>;
  /** Sum of (credit - debit) on the sales-GST (payable) accounts. */
  ledgerGstOnSales: string;
  /** Sum of (debit - credit) on the purchases-GST (receivable) accounts. */
  ledgerGstOnPurchases: string;
  ledgerNet: string;
  basNet: string;
  /** ledgerNet - basNet. Shown as-is: never plugged, never hidden. Zero means the BAS agrees with the control accounts. */
  variance: string;
  salesVariance: string;
  purchasesVariance: string;
}

export function reconcileToControlAccounts(
  activity: ControlAccountActivity[],
  figures: Pick<BasFigures, "labels">,
): BasReconciliation {
  let sales = ZERO;
  let purchases = ZERO;
  const accounts = activity.map((a) => {
    const debit = dec(a.debit);
    const credit = dec(a.credit);
    const movement = a.role === "SALES_GST" ? credit.minus(debit) : debit.minus(credit);
    if (a.role === "SALES_GST") sales = sales.plus(movement);
    else purchases = purchases.plus(movement);
    return { ...a, movement: fixed(movement) };
  });
  const basSales = dec(figures.labels["1A"]);
  const basPurchases = dec(figures.labels["1B"]);
  const ledgerNet = sales.minus(purchases);
  const basNet = basSales.minus(basPurchases);
  return {
    accounts,
    ledgerGstOnSales: fixed(sales),
    ledgerGstOnPurchases: fixed(purchases),
    ledgerNet: fixed(ledgerNet),
    basNet: fixed(basNet),
    variance: fixed(ledgerNet.minus(basNet)),
    salesVariance: fixed(sales.minus(basSales)),
    purchasesVariance: fixed(purchases.minus(basPurchases)),
  };
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function contentHash(report: unknown): string {
  return createHash("sha256").update(canonicalJson(report)).digest("hex");
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/**
 * Inclusive-end instant for a BAS period given as a calendar date (YYYY-MM-DD), matching the ledger's
 * `postingDate <= to` convention. The period start is 00:00:00.000Z of the start date.
 */
export function periodBounds(startIso: string, endIso: string): { from: Date; to: Date } {
  const from = new Date(`${startIso}T00:00:00.000Z`);
  const to = new Date(`${endIso}T23:59:59.999Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("Invalid BAS period dates.");
  return { from, to };
}

/** Calendar-month or calendar-quarter bounds containing `anchor` (UTC). A fixed calendar quarter is Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec. */
export function calendarPeriod(frequency: "MONTHLY" | "QUARTERLY", year: number, monthOrQuarter: number): { start: string; end: string } {
  if (frequency === "MONTHLY") {
    if (monthOrQuarter < 1 || monthOrQuarter > 12) throw new Error("Month must be 1-12.");
    const start = new Date(Date.UTC(year, monthOrQuarter - 1, 1));
    const end = new Date(Date.UTC(year, monthOrQuarter, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (monthOrQuarter < 1 || monthOrQuarter > 4) throw new Error("Quarter must be 1-4.");
  const start = new Date(Date.UTC(year, (monthOrQuarter - 1) * 3, 1));
  const end = new Date(Date.UTC(year, monthOrQuarter * 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
