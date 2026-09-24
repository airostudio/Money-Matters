import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Recurring invoicing — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("recurring-flow");
    owner = org.owner;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
  });

  async function createMonthlyTemplate(startDate: Date, opts: { endDate?: Date; maxOccurrences?: number } = {}) {
    return RecurringInvoiceService.create(owner, {
      customerContactId: fixtures.customerContactId,
      name: "Monthly retainer",
      currency: "AUD",
      arAccountId: fixtures.arAccountId,
      frequency: "MONTHLY",
      startDate,
      endDate: opts.endDate,
      maxOccurrences: opts.maxOccurrences,
      lines: [
        {
          description: "Retainer fee",
          quantity: "1",
          unitPrice: "500.00",
          accountId: fixtures.revenueAccountId,
          taxCodeId: fixtures.taxCodeId,
        },
      ],
    });
  }

  it("creates a template with nextRunDate seeded to its start date and zero occurrences", async () => {
    const template = await createMonthlyTemplate(new Date("2026-01-01"));
    const fetched = await RecurringInvoiceService.get(owner, template.id);
    expect(new Date(fetched!.nextRunDate).toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(fetched!.occurrencesGenerated).toBe(0);
    expect(fetched!.isActive).toBe(true);
  });

  it("generates a due invoice as a normal DRAFT, and advances nextRunDate by one period", async () => {
    const template = await createMonthlyTemplate(new Date("2026-01-01"));
    const asOf = new Date("2026-01-15");

    const generated = await RecurringInvoiceService.generateDue(owner, asOf);
    expect(generated).toHaveLength(1);

    const invoice = await InvoiceService.get(owner, generated[0]!.invoiceId);
    expect(invoice!.status).toBe("DRAFT");
    expect(invoice!.journalEntryId).toBeNull();
    expect(invoice!.total).toBe("550.0000");
    expect(invoice!.customerContactId).toBe(fixtures.customerContactId);

    const after = await RecurringInvoiceService.get(owner, template.id);
    expect(after!.occurrencesGenerated).toBe(1);
    expect(new Date(after!.nextRunDate).toISOString().slice(0, 10)).toBe("2026-02-01");
  });

  it("running generateDue twice on the same day does not double-generate", async () => {
    await createMonthlyTemplate(new Date("2026-01-01"));
    const asOf = new Date("2026-01-15");

    const firstRun = await RecurringInvoiceService.generateDue(owner, asOf);
    expect(firstRun).toHaveLength(1);

    const secondRun = await RecurringInvoiceService.generateDue(owner, asOf);
    expect(secondRun).toHaveLength(0);

    const invoices = await InvoiceService.list(owner);
    expect(invoices).toHaveLength(1);
  });

  it("catches up on every missed occurrence, not just the most recent one", async () => {
    await createMonthlyTemplate(new Date("2026-01-01"));
    // Nobody clicked "Generate due invoices" for three months.
    const asOf = new Date("2026-03-15");

    const generated = await RecurringInvoiceService.generateDue(owner, asOf);
    expect(generated).toHaveLength(3);
    expect(generated.map((g) => g.issueDate.toISOString().slice(0, 10))).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);

    const invoices = await InvoiceService.list(owner);
    expect(invoices).toHaveLength(3);
  });

  it("stops generating once maxOccurrences is reached and deactivates the template", async () => {
    await createMonthlyTemplate(new Date("2026-01-01"), { maxOccurrences: 2 });

    const generated = await RecurringInvoiceService.generateDue(owner, new Date("2026-06-01"));
    expect(generated).toHaveLength(2);

    const invoices = await InvoiceService.list(owner);
    expect(invoices).toHaveLength(2);

    const list = await RecurringInvoiceService.list(owner);
    expect(list[0]!.isActive).toBe(false);
    expect(list[0]!.occurrencesGenerated).toBe(2);
  });

  it("stops generating past the template's end date", async () => {
    await createMonthlyTemplate(new Date("2026-01-01"), { endDate: new Date("2026-02-15") });

    const generated = await RecurringInvoiceService.generateDue(owner, new Date("2026-06-01"));
    // Jan 1 and Feb 1 are <= the 15 Feb end date; Mar 1 is not.
    expect(generated).toHaveLength(2);
  });

  it("a paused template is skipped by generateDue", async () => {
    const template = await createMonthlyTemplate(new Date("2026-01-01"));
    await RecurringInvoiceService.setActive(owner, template.id, false);

    const generated = await RecurringInvoiceService.generateDue(owner, new Date("2026-02-01"));
    expect(generated).toHaveLength(0);
  });

  it("refuses to delete a template that has already generated an invoice", async () => {
    const template = await createMonthlyTemplate(new Date("2026-01-01"));
    await RecurringInvoiceService.generateDue(owner, new Date("2026-01-01"));

    await expect(RecurringInvoiceService.deleteTemplate(owner, template.id)).rejects.toThrow(/already generated/);
  });

  it("deletes a template that has never generated anything", async () => {
    const template = await createMonthlyTemplate(new Date("2026-01-01"));
    await RecurringInvoiceService.deleteTemplate(owner, template.id);
    expect(await RecurringInvoiceService.get(owner, template.id)).toBeNull();
  });
});
