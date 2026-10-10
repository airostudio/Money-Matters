import { BAS_LABELS, BAS_LABEL_TITLES } from "./bas-calculations";
import type { BasReport } from "./bas-service";

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * CSV of a prepared BAS: the labels, the memo/unclassified disclosures, the control-account reconciliation and every
 * source line (the drill-down). Every amount is the exact 4-dp decimal string from the report. NOT a lodgement file.
 */
export function basReportToCsv(report: BasReport, meta: { status: string; contentHash: string | null }): string {
  const rows: string[][] = [];
  rows.push(["Money Matters BAS preparation worksheet"]);
  rows.push([report.disclaimer]);
  rows.push(["Period", `${report.periodStart} to ${report.periodEnd}`, "Basis", report.basis, "Status", meta.status]);
  if (meta.contentHash) rows.push(["Content hash (SHA-256)", meta.contentHash]);
  rows.push([]);
  rows.push(["Label", "Description", "Amount (AUD)"]);
  for (const label of BAS_LABELS) rows.push([label, BAS_LABEL_TITLES[label], report.figures.labels[label]]);
  rows.push(["", "Net GST (1A - 1B); positive = payable", report.figures.netGst]);
  rows.push(["", "Money Matters summary, not an ATO label: 1A - 1B + W2", report.figures.netGstPlusPaygWithheld]);
  rows.push([]);
  rows.push(["Disclosures (NOT included in any label)"]);
  rows.push(["", "Input-taxed sales included in G1 (net)", report.figures.memo.inputTaxedSalesInG1]);
  rows.push(["", "Purchases under non-taxable codes excluded from G10/G11 (net)", report.figures.memo.otherPurchasesExcluded]);
  rows.push(["", "Sales under not-reported codes (net)", report.figures.memo.notReportedSales]);
  rows.push(["", "Unclassified sales lines", String(report.figures.unclassified.sales.count), report.figures.unclassified.sales.net, report.figures.unclassified.sales.gst]);
  rows.push(["", "Unclassified purchase lines", String(report.figures.unclassified.purchases.count), report.figures.unclassified.purchases.net, report.figures.unclassified.purchases.gst]);
  rows.push(["", "Tax-coded journal lines with no GST split", String(report.adHocTaxCodedLines.count), report.adHocTaxCodedLines.totalAmount]);
  rows.push([]);
  rows.push(["Reconciliation to GST control accounts"]);
  rows.push(["Account", "Name", "Role", "Debit", "Credit", "Movement"]);
  for (const a of report.reconciliation.accounts) rows.push([a.code, a.name, a.role, a.debit, a.credit, a.movement]);
  rows.push(["", "Ledger net GST", "", "", "", report.reconciliation.ledgerNet]);
  rows.push(["", "BAS net GST", "", "", "", report.reconciliation.basNet]);
  rows.push(["", "Variance (ledger - BAS), not plugged", "", "", "", report.reconciliation.variance]);
  rows.push([]);
  rows.push(["Warnings"]);
  for (const w of report.warnings) rows.push([w]);
  rows.push([]);
  rows.push(["Source lines"]);
  rows.push(["Document", "Number", "Line", "Event", "Posting date", "Side", "Tax code", "Treatment", "Net", "GST", "Sign", "G1", "G2", "G3", "G10", "G11", "1A", "1B", "Excluded because"]);
  for (const s of report.sources) {
    rows.push([
      s.docType,
      s.docNumber,
      String(s.lineNumber),
      s.event,
      s.postingDate,
      s.side,
      s.taxCodeCode ?? "",
      s.treatment ?? "UNCLASSIFIED",
      s.net,
      s.gst,
      String(s.sign),
      s.contributions.G1 ?? "",
      s.contributions.G2 ?? "",
      s.contributions.G3 ?? "",
      s.contributions.G10 ?? "",
      s.contributions.G11 ?? "",
      s.contributions["1A"] ?? "",
      s.contributions["1B"] ?? "",
      s.unclassifiedReason ?? s.memo ?? "",
    ]);
  }
  rows.push([]);
  rows.push(["Payroll source (posted pay runs)"]);
  rows.push(["Pay run", "Pay date", "Period", "Event", "W1 gross", "W2 PAYG withheld"]);
  for (const p of report.payroll) {
    rows.push([p.payRunId, p.payDate, `${p.periodStart} to ${p.periodEnd}`, p.event, p.gross, p.payg]);
  }
  return toCsv(rows);
}
