import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { BillService } from "@/domain/purchases/bill-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Recurring bills — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("recurring-bill-flow");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  async function createTemplate(overrides: Partial<Parameters<typeof RecurringBillService.create>[1]> = {}) {
    return RecurringBillService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      name: "Monthly cleaning service",
      currency: "AUD",
      apAccountId: fixtures.apAccountId,
      frequency: "MONTHLY",
      startDate: new Date("2026-01-01"),
      lines: [{ description: "Cleaning", quantity: "1", unitPrice: "200.00", accountId: fixtures.expenseAccountId, taxCodeId: fixtures.taxCodeId }],
      ...overrides,
    });
  }

  it("creates a template with no bill generated yet", async () => {
    const template = await createTemplate();
    const loaded = await RecurringBillService.get(owner, template.id);
    expect(loaded!.occurrencesGenerated).toBe(0);
    expect(loaded!.nextRunDate.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("generates every due occurrence up to asOfDate as DRAFT bills, never posted", async () => {
    await createTemplate();

    const generated = await RecurringBillService.generateDue(owner, new Date("2026-03-15"));
    // Jan 1, Feb 1, Mar 1 are all due by Mar 15.
    expect(generated).toHaveLength(3);

    for (const g of generated) {
      const bill = await BillService.get(owner, g.billId);
      expect(bill!.status).toBe("DRAFT");
      expect(bill!.journalEntryId).toBeNull();
      expect(bill!.total).toBe("220.0000");
    }
  });

  it("running generateDue twice on the same asOfDate is idempotent — no duplicate bills", async () => {
    await createTemplate();

    const first = await RecurringBillService.generateDue(owner, new Date("2026-01-15"));
    expect(first).toHaveLength(1);

    const second = await RecurringBillService.generateDue(owner, new Date("2026-01-15"));
    expect(second).toHaveLength(0);

    const bills = await BillService.list(owner, {});
    expect(bills).toHaveLength(1);
  });

  it("stops generating once maxOccurrences is reached and deactivates the template", async () => {
    await createTemplate({ maxOccurrences: 2 });

    const generated = await RecurringBillService.generateDue(owner, new Date("2026-06-01"));
    expect(generated).toHaveLength(2);

    const template = await RecurringBillService.list(owner, {});
    expect(template[0]!.isActive).toBe(false);
    expect(template[0]!.occurrencesGenerated).toBe(2);
  });

  it("a paused template generates nothing", async () => {
    const template = await createTemplate();
    await RecurringBillService.setActive(owner, template.id, false);

    const generated = await RecurringBillService.generateDue(owner, new Date("2026-06-01"));
    expect(generated).toHaveLength(0);
  });

  it("refuses to delete a template that has already generated bills", async () => {
    const template = await createTemplate();
    await RecurringBillService.generateDue(owner, new Date("2026-01-05"));
    await expect(RecurringBillService.deleteTemplate(owner, template.id)).rejects.toThrow();
  });
});
