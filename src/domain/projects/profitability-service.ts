import { and, eq, inArray, sql } from "drizzle-orm";
import { billLines, bills, expenseClaimLines, expenseClaims, invoiceLines, invoices, timesheetEntries } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { computeProjectVariance, type ProjectVarianceResult } from "./profitability-calculations";
import { loadProjectOr404 } from "./project-service";

/** Every invoice status with a real ledger posting behind it — the same "not DRAFT, not VOID" rule `sumPostedActivityByAccount` applies to journal entries, expressed here against `invoices.status` instead since a project's Actual revenue is attributed per invoice line, not per GL account. */
const POSTED_INVOICE_STATUSES = ["APPROVED", "SENT", "VIEWED", "PART_PAID", "PAID"] as const;
const POSTED_BILL_STATUSES = ["APPROVED", "PART_PAID", "PAID"] as const;
const POSTED_EXPENSE_CLAIM_STATUSES = ["APPROVED", "REIMBURSED"] as const;

/**
 * Sums every ledger-backed cost/revenue line attributed to a project, by
 * `projectId` on `invoice_lines`/`bill_lines`/`expense_claim_lines` (see
 * docs/database.md for why these are dedicated FK columns rather than the
 * generic dimension system). Only lines on a document that has actually
 * posted count — a DRAFT bill or invoice has no ledger effect yet, and a
 * VOID one has had its effect reversed — so this can never double-count or
 * count something that never actually happened financially. Pure
 * `drizzle` query-builder calls, no raw SQL strings, following the same
 * pattern as `src/domain/ledger/gl-aggregation.ts`.
 */
async function sumProjectActuals(tx: TenantDb, organizationId: string, projectId: string, currency: string) {
  const [revenueRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${invoiceLines.lineAmount}), 0)` })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(
      and(
        eq(invoiceLines.organizationId, organizationId),
        eq(invoiceLines.projectId, projectId),
        inArray(invoices.status, [...POSTED_INVOICE_STATUSES]),
      ),
    );

  const [billCostRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${billLines.lineAmount}), 0)` })
    .from(billLines)
    .innerJoin(bills, eq(bills.id, billLines.billId))
    .where(
      and(
        eq(billLines.organizationId, organizationId),
        eq(billLines.projectId, projectId),
        inArray(bills.status, [...POSTED_BILL_STATUSES]),
      ),
    );

  const [expenseCostRow] = await tx
    .select({ total: sql<string>`coalesce(sum(${expenseClaimLines.amount}), 0)` })
    .from(expenseClaimLines)
    .innerJoin(expenseClaims, eq(expenseClaims.id, expenseClaimLines.expenseClaimId))
    .where(
      and(
        eq(expenseClaimLines.organizationId, organizationId),
        eq(expenseClaimLines.projectId, projectId),
        inArray(expenseClaims.status, [...POSTED_EXPENSE_CLAIM_STATUSES]),
      ),
    );

  // Labour HOURS, split billable/non-billable, for approved-or-later time —
  // reported alongside the financials but NOT folded into Actual Cost: this
  // codebase has no per-employee hourly cost-rate concept yet (only a
  // billing rate), so there is no honest dollar figure to attribute labour
  // cost at. Billable time that has actually been invoiced already shows up
  // in Actual Revenue above via its invoice line; see docs/roadmap.md.
  const laborRows = await tx
    .select({
      billable: timesheetEntries.billable,
      hours: sql<string>`coalesce(sum(${timesheetEntries.hours}), 0)`,
    })
    .from(timesheetEntries)
    .where(
      and(
        eq(timesheetEntries.organizationId, organizationId),
        eq(timesheetEntries.projectId, projectId),
        inArray(timesheetEntries.status, ["APPROVED", "INVOICED"]),
      ),
    )
    .groupBy(timesheetEntries.billable);

  const billableHours = laborRows.find((r) => r.billable)?.hours ?? "0";
  const nonBillableHours = laborRows.find((r) => !r.billable)?.hours ?? "0";

  return {
    actualRevenue: revenueRow?.total ?? "0",
    actualCost: addDecimalStrings(billCostRow?.total ?? "0", expenseCostRow?.total ?? "0"),
    billCost: billCostRow?.total ?? "0",
    expenseCost: expenseCostRow?.total ?? "0",
    billableHours,
    nonBillableHours,
    currency,
  };
}

function addDecimalStrings(a: string, b: string): string {
  // Both inputs are already-summed Postgres `numeric` totals (exact decimal
  // strings), so a straightforward Number round-trip would reintroduce the
  // float error this codebase's money rule exists to avoid — go through
  // Money/Decimal instead. The currency tag is irrelevant here (both sides
  // are always the same project's currency); "X" is just a same/same
  // placeholder so `Money.add` doesn't need a real one.
  return Money.of(a, "X").add(Money.of(b, "X")).toDecimal().toFixed(4);
}

export interface ProjectProfitability extends ProjectVarianceResult {
  projectId: string;
  code: string;
  name: string;
  currency: string;
  billableHours: string;
  nonBillableHours: string;
}

export const ProjectProfitabilityService = {
  /**
   * Master spec §22's Estimated vs. Actual comparison for a single project —
   * Revenue/Cost/Profit/Margin on both sides, the variance, and a
   * plain-language explanation per line. See `sumProjectActuals`'s comment
   * for exactly what counts as "Actual" and the documented labour-cost
   * scope cut.
   */
  async get(actor: Actor, projectId: string): Promise<ProjectProfitability> {
    assertPermission(actor, "project:read");
    return withTenant(actor.organizationId, async (tx) => {
      const project = await loadProjectOr404(tx, actor.organizationId, projectId);
      const actuals = await sumProjectActuals(tx, actor.organizationId, projectId, project.currency);

      const variance = computeProjectVariance({
        currency: project.currency,
        estimated: { revenue: project.budgetedRevenue, cost: project.budgetedCost },
        actual: { revenue: actuals.actualRevenue, cost: actuals.actualCost },
        costBreakdown: [
          { label: "Supplier bills", estimated: "0", actual: actuals.billCost },
          { label: "Expense claims", estimated: "0", actual: actuals.expenseCost },
        ],
      });

      return {
        ...variance,
        projectId,
        code: project.code,
        name: project.name,
        currency: project.currency,
        billableHours: actuals.billableHours,
        nonBillableHours: actuals.nonBillableHours,
      };
    });
  },
};
