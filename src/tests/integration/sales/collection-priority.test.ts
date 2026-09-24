import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { ContactService } from "@/domain/contacts/contact-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { PaymentAllocationService } from "@/domain/sales/payment-service";
import { AgedReceivablesService } from "@/domain/sales/aged-receivables-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Collection Priority Score — seeded overdue invoices with different customer histories", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("collection-priority");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  async function createAndPostInvoice(customerContactId: string, issueDate: Date, dueDate: Date, amount: string) {
    const created = await InvoiceService.create(owner, {
      customerContactId,
      issueDate,
      dueDate,
      currency: "AUD",
      arAccountId: fixtures.arAccountId,
      lines: [{ description: "Work", quantity: "1", unitPrice: amount, accountId: fixtures.revenueAccountId }],
    });
    return InvoiceService.approveAndPost(owner, created.id);
  }

  it("ranks a large, very overdue invoice from a chronically-late customer above a small, barely-overdue one from a reliable customer", async () => {
    const reliableCustomer = await ContactService.create(owner, {
      kind: "CUSTOMER",
      displayName: "Reliable Co",
      currency: "AUD",
    });
    const lateCustomer = await ContactService.create(owner, {
      kind: "CUSTOMER",
      displayName: "Chronically Late Co",
      currency: "AUD",
    });

    // Reliable Co: a settled invoice paid right on its due date (0 days late).
    const reliableSettled = await createAndPostInvoice(reliableCustomer.id, new Date("2025-11-01"), new Date("2025-11-15"), "100.00");
    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: reliableCustomer.id,
      paymentDate: new Date("2025-11-15"),
      amount: "100.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: fixtures.bankGlAccountId,
      allocations: [{ invoiceId: reliableSettled.id, amount: "100.00" }],
    });
    // Reliable Co's currently-overdue invoice: small, barely overdue.
    await createAndPostInvoice(reliableCustomer.id, new Date("2026-01-01"), new Date("2026-01-10"), "50.00");

    // Chronically Late Co: a settled invoice paid 60 days after due.
    const lateSettled = await createAndPostInvoice(lateCustomer.id, new Date("2025-09-01"), new Date("2025-09-15"), "200.00");
    await PaymentAllocationService.recordPayment(owner, {
      customerContactId: lateCustomer.id,
      paymentDate: new Date("2025-11-14"),
      amount: "200.00",
      currency: "AUD",
      method: "BANK_TRANSFER",
      depositAccountId: fixtures.bankGlAccountId,
      allocations: [{ invoiceId: lateSettled.id, amount: "200.00" }],
    });
    // Chronically Late Co's currently-overdue invoice: large, very overdue.
    await createAndPostInvoice(lateCustomer.id, new Date("2025-10-01"), new Date("2025-10-15"), "5000.00");

    const asOfDate = new Date("2026-01-20");
    const prioritized = await AgedReceivablesService.getWithPriority(owner, asOfDate);

    const reliableRow = prioritized.find((r) => r.customerName === "Reliable Co");
    const lateRow = prioritized.find((r) => r.customerName === "Chronically Late Co");
    expect(reliableRow).toBeDefined();
    expect(lateRow).toBeDefined();

    expect(reliableRow!.customerAvgDaysLate).toBeCloseTo(0, 5);
    expect(lateRow!.customerAvgDaysLate).toBeCloseTo(60, 5);
    expect(lateRow!.priorityScore).toBeGreaterThan(reliableRow!.priorityScore);

    // Sorted highest priority first.
    expect(prioritized[0]!.priorityScore).toBe(Math.max(...prioritized.map((r) => r.priorityScore)));
  });

  it("gives a customer with no settled invoice history a defined (non-null-crashing) neutral score", async () => {
    await createAndPostInvoice(fixtures.customerContactId, new Date("2026-01-01"), new Date("2026-01-05"), "300.00");

    const prioritized = await AgedReceivablesService.getWithPriority(owner, new Date("2026-01-20"));
    expect(prioritized).toHaveLength(1);
    expect(prioritized[0]!.customerAvgDaysLate).toBeNull();
    expect(prioritized[0]!.priorityScore).toBeGreaterThan(0);
  });
});
