import type { SourceDocumentRef } from "./reporting-service";

/**
 * Where a `SourceDocumentRef` links to in the UI — shared between the
 * account-transactions drill-down page and the Journal Entry detail page,
 * the two places master spec §32's "→ Source Document" hop is rendered.
 * `CUSTOMER_PAYMENT`/`SUPPLIER_PAYMENT` return `null`: this codebase has no
 * dedicated detail page for a standalone payment yet (a payment is shown
 * inline on its invoice/bill's own detail page today), so those render as
 * plain text instead of a broken link.
 */
export function sourceDocumentHref(orgSlug: string, doc: SourceDocumentRef): string | null {
  switch (doc.type) {
    case "INVOICE":
      return `/${orgSlug}/sales/invoices/${doc.id}`;
    case "BILL":
      return `/${orgSlug}/purchases/bills/${doc.id}`;
    case "SUPPLIER_CREDIT_NOTE":
      return `/${orgSlug}/purchases/supplier-credits/${doc.id}`;
    case "EXPENSE_CLAIM":
      return `/${orgSlug}/expenses/${doc.id}`;
    case "CUSTOMER_PAYMENT":
    case "SUPPLIER_PAYMENT":
      return null;
  }
}

export const SOURCE_DOCUMENT_LABEL: Record<SourceDocumentRef["type"], string> = {
  INVOICE: "Invoice",
  BILL: "Bill",
  SUPPLIER_CREDIT_NOTE: "Supplier Credit",
  EXPENSE_CLAIM: "Expense Claim",
  CUSTOMER_PAYMENT: "Customer Payment",
  SUPPLIER_PAYMENT: "Supplier Payment",
};
