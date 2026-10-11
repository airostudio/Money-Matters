import { AGING_BUCKETS } from "./aged-receivables-service";
import type { Statement } from "./statement-service";

const BUCKET_LABEL: Record<string, string> = {
  current: "Current",
  days1to30: "1-30 days",
  days31to60: "31-60 days",
  days61to90: "61-90 days",
  days90plus: "90+ days",
};

/** Free text is user-entered (memos, references); a leading formula character is neutralised so a spreadsheet never runs it. */
function text(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** The statement as CSV: header, opening balance, every line with its running balance, closing balance, aged summary. Amounts are the exact 4-dp strings from the statement. */
export function statementToCsv(s: Statement): string {
  const rows: string[][] = [];
  rows.push(["Customer statement"]);
  rows.push(["Organisation", text(s.organizationName)]);
  rows.push(["Customer", text(s.customer.name)]);
  rows.push(["Period", `${s.from} to ${s.to}`, "Currency", s.currency]);
  rows.push([]);
  rows.push(["Date", "Type", "Number", "Description", "Charges", "Credits", "Balance"]);
  rows.push([s.from, "Opening balance", "", "", "", "", s.openingBalance]);
  for (const l of s.lines) {
    rows.push([l.date, l.type.replace(/_/g, " ").toLowerCase(), text(l.number), text(l.description), l.charge, l.credit, l.balance]);
  }
  rows.push([s.to, "Closing balance", "", "", s.totalCharges, s.totalCredits, s.closingBalance]);
  rows.push([]);
  rows.push([`Aged summary as at ${s.aging.asAt}`]);
  rows.push(AGING_BUCKETS.map((b) => BUCKET_LABEL[b]!).concat(["Open invoices", "Unapplied credit", "Total"]));
  rows.push(
    AGING_BUCKETS.map((b) => s.aging.buckets[b]).concat([s.aging.openInvoicesTotal, `-${s.aging.unappliedCreditsTotal}`, s.aging.total]),
  );
  rows.push([]);
  rows.push(["Reconciliation"]);
  rows.push(["Closing balance", s.reconciliation.closingBalance]);
  rows.push(["Aged total (open invoices less unapplied credit)", s.reconciliation.agedTotal]);
  rows.push(["Variance", s.reconciliation.variance, s.reconciliation.reconciled ? "Reconciled" : "NOT RECONCILED"]);
  if (s.excludedForeignCurrencyDocuments > 0) {
    rows.push([`${s.excludedForeignCurrencyDocuments} document(s) in another currency are not included.`]);
  }
  return toCsv(rows);
}
