import { and, desc, eq, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import { employees, leaveRequests } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { LeaveRequestError } from "./errors";

export type LeaveRequestRow = typeof leaveRequests.$inferSelect;
export type LeaveType = "ANNUAL" | "PERSONAL";

export interface LeaveRequestView extends LeaveRequestRow {
  employeeName: string;
}

function can(actor: Actor, permission: "leave:read" | "leave:approve" | "leave:request"): boolean {
  return roleHasPermission(actor.role, permission) && (!actor.grantedPermissions || actor.grantedPermissions.has(permission));
}

function assertHuman(actor: Actor, permission: "leave:request" | "leave:approve"): void {
  assertPermission(actor, permission);
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError(permission, actor.role);
}

async function myEmployee(tx: TenantDb, actor: Actor) {
  const [emp] = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.organizationId, actor.organizationId), eq(employees.userId, actor.userId), eq(employees.status, "ACTIVE")));
  return emp ?? null;
}

/** Hours already promised: APPROVED requests of this type not yet deducted by a pay run. */
async function committedHours(tx: TenantDb, organizationId: string, employeeId: string, type: LeaveType): Promise<Decimal> {
  const rows = await tx
    .select({ hours: leaveRequests.hours })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.organizationId, organizationId),
        eq(leaveRequests.employeeId, employeeId),
        eq(leaveRequests.leaveType, type),
        eq(leaveRequests.status, "APPROVED"),
        isNull(leaveRequests.appliedPayRunId),
      ),
    );
  return rows.reduce((s, r) => s.plus(r.hours), new Decimal(0));
}

/**
 * Leave request / approval workflow (Phase 8 Slice 3).
 *  - An employee requests hours of ANNUAL or PERSONAL leave for themselves (their login must be linked to an ACTIVE
 *    employee record). The hours are entered by them; there is no roster, public-holiday or NES entitlement logic.
 *  - Someone with `leave:approve` decides it; nobody can decide their own request. Approval is refused when the hours
 *    (plus other approved-but-undeducted leave of that type) exceed the employee's current balance.
 *  - Approved leave is deducted from the balance when the next pay run covering its start date is POSTED
 *    (`PayRunService`). It is balance-only: gross pay is NOT changed, so for an HOURLY employee the payroll manager must
 *    still enter the paid hours.
 * Human-only throughout.
 */
export const LeaveService = {
  async request(
    actor: Actor,
    input: { leaveType: LeaveType; startDate: Date; endDate: Date; hours: string; reason?: string },
  ): Promise<LeaveRequestRow> {
    assertHuman(actor, "leave:request");
    let hours: Decimal;
    try {
      hours = new Decimal(input.hours);
    } catch {
      throw new LeaveRequestError("Enter the leave hours as a number.");
    }
    if (!hours.isFinite() || hours.lte(0) || hours.gt(2000)) throw new LeaveRequestError("Leave hours must be greater than zero.");
    if (input.endDate < input.startDate) throw new LeaveRequestError("The end date must not be before the start date.");
    return withTenant(actor.organizationId, async (tx) => {
      const emp = await myEmployee(tx, actor);
      if (!emp) throw new LeaveRequestError("Your login is not linked to an active employee record, so you cannot request leave.");
      const [row] = await tx
        .insert(leaveRequests)
        .values({
          organizationId: actor.organizationId,
          employeeId: emp.id,
          leaveType: input.leaveType,
          startDate: input.startDate,
          endDate: input.endDate,
          hours: hours.toFixed(4),
          reason: input.reason?.trim() || null,
          requestedById: actor.userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create the leave request.");
      await AuditService.record(tx, actor, {
        action: "leave_request.created",
        entityType: "LeaveRequest",
        entityId: row.id,
        after: { employeeId: emp.id, leaveType: input.leaveType, hours: hours.toFixed(4) },
      });
      return row;
    });
  },

  /** Own requests for everyone with `leave:request`; everyone's for `leave:read`. */
  async list(actor: Actor, opts: { scope: "mine" | "all"; status?: LeaveRequestRow["status"] }): Promise<LeaveRequestView[]> {
    if (opts.scope === "all") assertPermission(actor, "leave:read");
    else assertPermission(actor, "leave:request");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(leaveRequests.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(leaveRequests.status, opts.status));
      if (opts.scope === "mine") conditions.push(eq(leaveRequests.requestedById, actor.userId));
      const rows = await tx
        .select({ request: leaveRequests, employeeName: employees.name })
        .from(leaveRequests)
        .innerJoin(employees, eq(employees.id, leaveRequests.employeeId))
        .where(and(...conditions))
        .orderBy(desc(leaveRequests.createdAt));
      return rows.map((r) => ({ ...r.request, employeeName: r.employeeName }));
    });
  },

  async approve(actor: Actor, id: string, note?: string): Promise<LeaveRequestRow> {
    assertHuman(actor, "leave:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const req = await load(tx, actor.organizationId, id);
      if (req.status !== "PENDING") throw new LeaveRequestError("Only a PENDING request can be approved.");
      if (req.requestedById === actor.userId) throw new LeaveRequestError("You cannot approve your own leave request.");
      const [emp] = await tx.select().from(employees).where(eq(employees.id, req.employeeId));
      if (!emp) throw new LeaveRequestError("The employee record no longer exists.");
      if (emp.userId === actor.userId) throw new LeaveRequestError("You cannot approve your own leave request.");
      const balance = new Decimal(req.leaveType === "ANNUAL" ? emp.annualLeaveBalanceHours : emp.personalLeaveBalanceHours);
      const committed = await committedHours(tx, actor.organizationId, emp.id, req.leaveType);
      const available = balance.minus(committed);
      if (new Decimal(req.hours).gt(available)) {
        throw new LeaveRequestError(
          `${req.leaveType === "ANNUAL" ? "Annual" : "Personal"} leave balance is ${available.toFixed(4)} hours after other approved leave; the request is for ${req.hours}.`,
        );
      }
      const [row] = await tx
        .update(leaveRequests)
        .set({ status: "APPROVED", decidedById: actor.userId, decidedAt: new Date(), decisionNote: note?.trim() || null, updatedAt: new Date() })
        .where(and(eq(leaveRequests.id, id), eq(leaveRequests.status, "PENDING")))
        .returning();
      if (!row) throw new LeaveRequestError("The request changed while you were deciding it.");
      await AuditService.record(tx, actor, {
        action: "leave_request.approved",
        entityType: "LeaveRequest",
        entityId: id,
        before: { status: "PENDING" },
        after: { status: "APPROVED", hours: req.hours },
      });
      return row;
    });
  },

  async reject(actor: Actor, id: string, note?: string): Promise<LeaveRequestRow> {
    assertHuman(actor, "leave:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const req = await load(tx, actor.organizationId, id);
      if (req.status !== "PENDING") throw new LeaveRequestError("Only a PENDING request can be rejected.");
      if (req.requestedById === actor.userId) throw new LeaveRequestError("You cannot decide your own leave request.");
      const [row] = await tx
        .update(leaveRequests)
        .set({ status: "REJECTED", decidedById: actor.userId, decidedAt: new Date(), decisionNote: note?.trim() || null, updatedAt: new Date() })
        .where(and(eq(leaveRequests.id, id), eq(leaveRequests.status, "PENDING")))
        .returning();
      if (!row) throw new LeaveRequestError("The request changed while you were deciding it.");
      await AuditService.record(tx, actor, {
        action: "leave_request.rejected",
        entityType: "LeaveRequest",
        entityId: id,
        before: { status: "PENDING" },
        after: { status: "REJECTED" },
      });
      return row;
    });
  },

  /** The requester withdraws a PENDING request, or an APPROVED one that no pay run has deducted yet. */
  async cancel(actor: Actor, id: string): Promise<LeaveRequestRow> {
    assertHuman(actor, "leave:request");
    return withTenant(actor.organizationId, async (tx) => {
      const req = await load(tx, actor.organizationId, id);
      if (req.requestedById !== actor.userId) throw new LeaveRequestError("You can only cancel your own request.");
      if (req.status === "APPROVED" && req.appliedPayRunId) {
        throw new LeaveRequestError("This leave has already been deducted by a pay run and cannot be cancelled.");
      }
      if (req.status !== "PENDING" && req.status !== "APPROVED") throw new LeaveRequestError("This request can no longer be cancelled.");
      const [row] = await tx
        .update(leaveRequests)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(eq(leaveRequests.id, id))
        .returning();
      await AuditService.record(tx, actor, {
        action: "leave_request.cancelled",
        entityType: "LeaveRequest",
        entityId: id,
        before: { status: req.status },
        after: { status: "CANCELLED" },
      });
      return row!;
    });
  },

  canReadAll(actor: Actor): boolean {
    return can(actor, "leave:read");
  },
};

async function load(tx: TenantDb, organizationId: string, id: string): Promise<LeaveRequestRow> {
  const [row] = await tx
    .select()
    .from(leaveRequests)
    .where(and(eq(leaveRequests.id, id), eq(leaveRequests.organizationId, organizationId)));
  if (!row) throw new LeaveRequestError("Leave request not found.");
  return row;
}
