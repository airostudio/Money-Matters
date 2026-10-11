import { describe, expect, it } from "vitest";
import { INVOICE_FILTERS, matchesInvoiceFilter, parseInvoiceFilter } from "@/domain/sales/invoice-filters";
import { invoiceStatusEnum } from "@/db/schema";

const now = new Date("2026-06-15T00:00:00Z");
const past = new Date("2026-06-01T00:00:00Z");
const future = new Date("2026-07-01T00:00:00Z");

describe("invoice list quick filters (Find unpaid invoices)", () => {
  it("parses only the known filter names", () => {
    expect(parseInvoiceFilter("unpaid")).toBe("unpaid");
    expect(parseInvoiceFilter("overdue")).toBe("overdue");
    for (const bad of [undefined, null, "", "UNPAID", "paid", "unpaid;drop", "__proto__", "constructor"]) {
      expect(parseInvoiceFilter(bad as string | undefined | null), String(bad)).toBeUndefined();
    }
    expect([...INVOICE_FILTERS]).toEqual(["unpaid", "overdue"]);
  });

  it("unpaid = posted and not settled: approved, sent, viewed, part-paid; never draft, paid or void", () => {
    const unpaid = invoiceStatusEnum.enumValues.filter((status) => matchesInvoiceFilter("unpaid", { status, dueDate: future }, now));
    expect(unpaid).toEqual(["APPROVED", "SENT", "VIEWED", "PART_PAID"]);
  });

  it("overdue = unpaid and past its due date (a due date of 'now' is not yet overdue)", () => {
    expect(matchesInvoiceFilter("overdue", { status: "SENT", dueDate: past }, now)).toBe(true);
    expect(matchesInvoiceFilter("overdue", { status: "PART_PAID", dueDate: past.toISOString() }, now)).toBe(true);
    expect(matchesInvoiceFilter("overdue", { status: "SENT", dueDate: future }, now)).toBe(false);
    expect(matchesInvoiceFilter("overdue", { status: "SENT", dueDate: now }, now)).toBe(false);
    for (const status of ["DRAFT", "PAID", "VOID"]) {
      expect(matchesInvoiceFilter("overdue", { status, dueDate: past }, now), status).toBe(false);
    }
  });

  it("agrees with the list page's own 'overdue' badge rule for every status", () => {
    // The page badges an invoice overdue when its status is not DRAFT / VOID / PAID and the due date has passed.
    for (const status of invoiceStatusEnum.enumValues) {
      const badge = !["DRAFT", "VOID", "PAID"].includes(status) && past < now;
      expect(matchesInvoiceFilter("overdue", { status, dueDate: past }, now), status).toBe(badge);
    }
  });
});
