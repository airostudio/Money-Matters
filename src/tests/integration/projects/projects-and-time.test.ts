import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createProjectFixtures } from "../../helpers/projects";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { ProjectService } from "@/domain/projects/project-service";
import { TimesheetService } from "@/domain/projects/timesheet-service";
import { ProjectTimeBillingService } from "@/domain/projects/project-time-billing-service";
import { ProjectProfitabilityService } from "@/domain/projects/profitability-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Projects/Jobs & Time Tracking — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createProjectFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("projects-flow");
    owner = org.owner;
    fixtures = await createProjectFixtures(owner, org.baseCurrency);
  });

  async function createActiveProject(overrides: Partial<Parameters<typeof ProjectService.create>[1]> = {}) {
    return ProjectService.create(owner, {
      customerContactId: fixtures.customerContactId,
      code: `PROJ-${fixtures.projectCodeSuffix}`,
      name: "Office Fitout",
      currency: "AUD",
      budgetedRevenue: "20000.00",
      budgetedCost: "12000.00",
      defaultHourlyRate: "150.00",
      ...overrides,
    });
  }

  it("creates a project with a budget and tasks", async () => {
    const project = await createActiveProject();
    expect(project.status).toBe("ACTIVE");
    expect(project.budgetedRevenue).toBe("20000.0000");

    const task = await ProjectService.createTask(owner, project.id, { name: "Wiring", budgetedHours: "40" });
    const full = await ProjectService.get(owner, project.id);
    expect(full!.tasks).toHaveLength(1);
    expect(full!.tasks[0]!.id).toBe(task.id);
  });

  it("refuses a duplicate project code in the same org", async () => {
    await createActiveProject();
    await expect(createActiveProject()).rejects.toThrow(/already in use/);
  });

  it("logs time manually and via a start/stop timer onto the same table", async () => {
    const project = await createActiveProject();
    const task = await ProjectService.createTask(owner, project.id, { name: "Wiring" });

    const manual = await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      taskId: task.id,
      entryDate: new Date("2026-03-01"),
      hours: "3.50",
      billable: true,
    });
    expect(manual.status).toBe("DRAFT");
    expect(manual.hours).toBe("3.50");

    const started = await TimesheetService.startTimer(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      taskId: task.id,
    });
    expect(started.startedAt).toBeTruthy();
    expect(started.endedAt).toBeNull();

    await expect(
      TimesheetService.startTimer(owner, { employeeUserId: owner.userId, projectId: project.id }),
    ).rejects.toThrow(/already have a running timer/);

    const stopped = await TimesheetService.stopTimer(owner, owner.userId);
    expect(stopped!.endedAt).toBeTruthy();
    expect(Number(stopped!.hours)).toBeGreaterThanOrEqual(0);

    await expect(TimesheetService.stopTimer(owner, owner.userId)).rejects.toThrow(/no running timer/);
  });

  it("submits and approves time; rejects approving a draft", async () => {
    const project = await createActiveProject();
    const entry = await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date("2026-03-01"),
      hours: "4.00",
    });

    await expect(TimesheetService.approve(owner, entry.id)).rejects.toThrow(/not been submitted/);

    const submitted = await TimesheetService.submit(owner, entry.id);
    expect(submitted!.status).toBe("SUBMITTED");

    const approved = await TimesheetService.approve(owner, entry.id);
    expect(approved!.status).toBe("APPROVED");
  });

  it("refuses to edit an approved entry; a rejected entry can be edited and resubmitted", async () => {
    const project = await createActiveProject();
    const entry = await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date("2026-03-01"),
      hours: "4.00",
    });
    await TimesheetService.submit(owner, entry.id);
    await TimesheetService.approve(owner, entry.id);

    await expect(
      TimesheetService.update(owner, entry.id, {
        employeeUserId: owner.userId,
        projectId: project.id,
        entryDate: new Date(),
        hours: "5.00",
      }),
    ).rejects.toThrow(/not editable/);

    const entry2 = await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date("2026-03-02"),
      hours: "2.00",
    });
    await TimesheetService.submit(owner, entry2.id);
    const rejected = await TimesheetService.reject(owner, entry2.id, "Wrong project");
    expect(rejected!.status).toBe("REJECTED");

    const corrected = await TimesheetService.update(owner, entry2.id, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date("2026-03-02"),
      hours: "2.50",
    });
    expect(corrected!.status).toBe("DRAFT");
    expect(corrected!.hours).toBe("2.50");
  });

  async function loggedApprovedHours(project: Awaited<ReturnType<typeof createActiveProject>>, hours: string, date = "2026-03-01") {
    const entry = await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date(date),
      hours,
      billable: true,
    });
    await TimesheetService.submit(owner, entry.id);
    return TimesheetService.approve(owner, entry.id);
  }

  it("generates a draft invoice from unbilled approved time, marks entries INVOICED, and a re-run never double-bills", async () => {
    const project = await createActiveProject();
    await loggedApprovedHours(project, "5.00", "2026-03-01");
    await loggedApprovedHours(project, "3.00", "2026-03-02");

    const result = await ProjectTimeBillingService.createInvoiceFromUnbilledTime(owner, {
      projectId: project.id,
      issueDate: new Date("2026-03-10"),
      dueDate: new Date("2026-03-24"),
      arAccountId: fixtures.arAccountId,
      revenueAccountId: fixtures.revenueAccountId,
    });

    expect(result.entriesInvoiced).toBe(2);
    const invoice = await InvoiceService.get(owner, result.invoice.id);
    expect(invoice!.status).toBe("DRAFT");
    // 8 total hours at the project's $150/hr default rate.
    expect(invoice!.total).toBe("1200.0000");

    const entries = await TimesheetService.list(owner, { projectId: project.id });
    expect(entries.every((e) => e.status === "INVOICED")).toBe(true);
    expect(entries.every((e) => e.invoiceId === result.invoice.id)).toBe(true);
    expect(entries.every((e) => e.invoiceLineId !== null)).toBe(true);

    // Re-running with the same (or an overlapping) range picks up nothing —
    // every entry is already linked to an invoice.
    await expect(
      ProjectTimeBillingService.createInvoiceFromUnbilledTime(owner, {
        projectId: project.id,
        issueDate: new Date("2026-03-11"),
        dueDate: new Date("2026-03-25"),
        arAccountId: fixtures.arAccountId,
        revenueAccountId: fixtures.revenueAccountId,
      }),
    ).rejects.toThrow(/No approved, billable/);
  });

  it("only bills approved, billable, un-invoiced time — drafts, submitted, non-billable and already-invoiced time are excluded", async () => {
    const project = await createActiveProject();
    await loggedApprovedHours(project, "2.00", "2026-04-01"); // will be billed

    // A draft, never submitted.
    await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date("2026-04-02"),
      hours: "1.00",
    });

    // Submitted but not yet approved.
    const submittedOnly = await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date("2026-04-03"),
      hours: "1.00",
    });
    await TimesheetService.submit(owner, submittedOnly.id);

    // Approved but non-billable.
    const nonBillable = await TimesheetService.createManual(owner, {
      employeeUserId: owner.userId,
      projectId: project.id,
      entryDate: new Date("2026-04-04"),
      hours: "1.00",
      billable: false,
    });
    await TimesheetService.submit(owner, nonBillable.id);
    await TimesheetService.approve(owner, nonBillable.id);

    const preview = await ProjectTimeBillingService.previewUnbilled(owner, project.id);
    expect(preview.totalHours).toBe("2.0000");

    const result = await ProjectTimeBillingService.createInvoiceFromUnbilledTime(owner, {
      projectId: project.id,
      issueDate: new Date("2026-04-10"),
      dueDate: new Date("2026-04-24"),
      arAccountId: fixtures.arAccountId,
      revenueAccountId: fixtures.revenueAccountId,
    });
    expect(result.entriesInvoiced).toBe(1);
  });

  it("attributes a posted bill to a project and reflects it in Actual Cost", async () => {
    const project = await createActiveProject();
    const purchaseFixtures = await createPurchasesFixtures(owner, "AUD");

    const bill = await BillService.create(owner, {
      supplierContactId: purchaseFixtures.supplierContactId,
      issueDate: new Date("2026-03-01"),
      dueDate: new Date("2026-03-31"),
      currency: "AUD",
      apAccountId: purchaseFixtures.apAccountId,
      lines: [
        {
          description: "Materials",
          quantity: "1",
          unitPrice: "2000.00",
          accountId: purchaseFixtures.expenseAccountId,
          projectId: project.id,
        },
      ],
    });

    // Before posting, a DRAFT bill contributes nothing to Actual Cost.
    const beforePosting = await ProjectProfitabilityService.get(owner, project.id);
    expect(beforePosting.actual.cost).toBe("0.0000");

    await BillService.approveAndPost(owner, bill.id);

    const after = await ProjectProfitabilityService.get(owner, project.id);
    expect(after.actual.cost).toBe("2000.0000");
    expect(after.estimated.cost).toBe("12000.0000");
    expect(after.variance.cost).toBe("-10000.0000");
  });

  it("computes Estimated vs Actual including invoiced time as Actual Revenue", async () => {
    const project = await createActiveProject({ budgetedRevenue: "5000.00", budgetedCost: "1000.00" });
    await loggedApprovedHours(project, "10.00", "2026-05-01"); // 10h * $150 = $1500

    const created = await ProjectTimeBillingService.createInvoiceFromUnbilledTime(owner, {
      projectId: project.id,
      issueDate: new Date("2026-05-05"),
      dueDate: new Date("2026-05-19"),
      arAccountId: fixtures.arAccountId,
      revenueAccountId: fixtures.revenueAccountId,
    });

    // Still DRAFT — no ledger effect, so Actual Revenue is still zero.
    const whileDraft = await ProjectProfitabilityService.get(owner, project.id);
    expect(whileDraft.actual.revenue).toBe("0.0000");

    await InvoiceService.approveAndPost(owner, created.invoice.id);

    const posted = await ProjectProfitabilityService.get(owner, project.id);
    expect(posted.actual.revenue).toBe("1500.0000");
    expect(posted.estimated.revenue).toBe("5000.0000");
    expect(posted.variance.revenue).toBe("-3500.0000");
  });
});
