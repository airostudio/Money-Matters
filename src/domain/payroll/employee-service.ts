import { and, asc, eq } from "drizzle-orm";
import { employees } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { maskLast4 } from "./sensitive-data";
import { EmployeeNotActiveError, EmployeeNotFoundError, InvalidEmployeeError } from "./errors";
import type { CreateEmployeeInput, EmployeeView, UpdateEmployeeInput } from "./types";

export async function loadEmployeeOr404(tx: TenantDb, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.id, id), eq(employees.organizationId, organizationId)));
  if (!row) throw new EmployeeNotFoundError(id);
  return row;
}

function validateInput(input: CreateEmployeeInput | UpdateEmployeeInput) {
  if (!input.name.trim()) throw new InvalidEmployeeError("A name is required.");
  if (input.employmentBasis === "SALARY") {
    if (!input.annualSalary || Number(input.annualSalary) <= 0) {
      throw new InvalidEmployeeError("A SALARY employee requires a positive annualSalary.");
    }
  } else if (input.employmentBasis === "HOURLY") {
    if (!input.hourlyRate || Number(input.hourlyRate) <= 0) {
      throw new InvalidEmployeeError("An HOURLY employee requires a positive hourlyRate.");
    }
  }
  if (input.standardHoursPerWeek !== undefined && Number(input.standardHoursPerWeek) <= 0) {
    throw new InvalidEmployeeError("standardHoursPerWeek must be positive.");
  }
}

/** Projects a DB row to `EmployeeView` — `includeFullTfn` controls whether the real `tfn` value is ever placed on the result at all (never just hidden client-side). */
function toView(row: typeof employees.$inferSelect, includeFullTfn: boolean): EmployeeView {
  return {
    id: row.id,
    name: row.name,
    employmentBasis: row.employmentBasis,
    annualSalary: row.annualSalary,
    hourlyRate: row.hourlyRate,
    standardHoursPerWeek: row.standardHoursPerWeek,
    payFrequency: row.payFrequency,
    taxFreeThresholdClaimed: row.taxFreeThresholdClaimed,
    startDate: row.startDate.toISOString().slice(0, 10),
    terminationDate: row.terminationDate ? row.terminationDate.toISOString().slice(0, 10) : null,
    status: row.status,
    userId: row.userId,
    tfn: includeFullTfn ? row.tfn : null,
    tfnMasked: maskLast4(row.tfn),
    superFundName: row.superFundName,
    superFundAbn: row.superFundAbn,
    superMemberAccountNumber: row.superMemberAccountNumber,
    bankAccountName: row.bankAccountName,
    bankBsb: row.bankBsb,
    bankAccountNumberMasked: maskLast4(row.bankAccountNumber),
    annualLeaveBalanceHours: row.annualLeaveBalanceHours,
    personalLeaveBalanceHours: row.personalLeaveBalanceHours,
  };
}

/**
 * Employee onboarding/edit/termination (master spec §8). Deliberately its
 * own table rather than a repurposed `contacts` row — see `employees`'
 * schema comment in src/db/schema.ts for why.
 *
 * **TFN handling**: `get`/`list` only ever place the real `tfn` value on
 * the returned view when the caller holds `employee:manage` — a role with
 * only `employee:read` (e.g. ACCOUNTANT, BOOKKEEPER — see roles.ts) always
 * receives `tfn: null` and must use `tfnMasked` (last-4 digits) instead.
 * This is enforced here, in the one place every UI/API caller goes through,
 * not left to each page to remember.
 */
export const EmployeeService = {
  async list(actor: Actor, opts: { status?: "ACTIVE" | "TERMINATED" } = {}): Promise<EmployeeView[]> {
    assertPermission(actor, "employee:read");
    const canManage = roleCanManage(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(employees.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(employees.status, opts.status));
      const rows = await tx
        .select()
        .from(employees)
        .where(and(...conditions))
        .orderBy(asc(employees.name));
      return rows.map((r) => toView(r, canManage));
    });
  },

  async get(actor: Actor, id: string): Promise<EmployeeView> {
    assertPermission(actor, "employee:read");
    const canManage = roleCanManage(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const row = await loadEmployeeOr404(tx, actor.organizationId, id);
      return toView(row, canManage);
    });
  },

  async create(actor: Actor, input: CreateEmployeeInput) {
    assertPermission(actor, "employee:manage");
    validateInput(input);
    return withTenant(actor.organizationId, async (tx) => {
      const [created] = await tx
        .insert(employees)
        .values({
          organizationId: actor.organizationId,
          userId: input.userId ?? null,
          name: input.name.trim(),
          employmentBasis: input.employmentBasis,
          annualSalary: input.employmentBasis === "SALARY" ? input.annualSalary ?? null : null,
          hourlyRate: input.employmentBasis === "HOURLY" ? input.hourlyRate ?? null : null,
          standardHoursPerWeek: input.standardHoursPerWeek ?? "38.00",
          payFrequency: input.payFrequency,
          taxFreeThresholdClaimed: input.taxFreeThresholdClaimed ?? true,
          startDate: input.startDate,
          tfn: input.tfn ?? null,
          superFundName: input.superFundName ?? null,
          superFundAbn: input.superFundAbn ?? null,
          superMemberAccountNumber: input.superMemberAccountNumber ?? null,
          bankAccountName: input.bankAccountName ?? null,
          bankBsb: input.bankBsb ?? null,
          bankAccountNumber: input.bankAccountNumber ?? null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create employee.");

      await AuditService.record(tx, actor, {
        action: "employee.created",
        entityType: "Employee",
        entityId: created.id,
        after: { name: created.name, employmentBasis: created.employmentBasis, tfn: created.tfn, bankAccountNumber: created.bankAccountNumber },
      });

      return toView(created, true);
    });
  },

  async update(actor: Actor, id: string, input: UpdateEmployeeInput) {
    assertPermission(actor, "employee:manage");
    validateInput(input);
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadEmployeeOr404(tx, actor.organizationId, id);

      const [updated] = await tx
        .update(employees)
        .set({
          userId: input.userId ?? existing.userId,
          name: input.name.trim(),
          employmentBasis: input.employmentBasis,
          annualSalary: input.employmentBasis === "SALARY" ? input.annualSalary ?? null : null,
          hourlyRate: input.employmentBasis === "HOURLY" ? input.hourlyRate ?? null : null,
          standardHoursPerWeek: input.standardHoursPerWeek ?? existing.standardHoursPerWeek,
          payFrequency: input.payFrequency,
          taxFreeThresholdClaimed: input.taxFreeThresholdClaimed ?? existing.taxFreeThresholdClaimed,
          startDate: input.startDate ?? existing.startDate,
          tfn: input.tfn ?? existing.tfn,
          superFundName: input.superFundName ?? existing.superFundName,
          superFundAbn: input.superFundAbn ?? existing.superFundAbn,
          superMemberAccountNumber: input.superMemberAccountNumber ?? existing.superMemberAccountNumber,
          bankAccountName: input.bankAccountName ?? existing.bankAccountName,
          bankBsb: input.bankBsb ?? existing.bankBsb,
          bankAccountNumber: input.bankAccountNumber ?? existing.bankAccountNumber,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(employees.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "employee.updated",
        entityType: "Employee",
        entityId: id,
        before: { name: existing.name, tfn: existing.tfn, bankAccountNumber: existing.bankAccountNumber },
        after: { name: input.name, tfn: input.tfn ?? existing.tfn, bankAccountNumber: input.bankAccountNumber ?? existing.bankAccountNumber },
      });

      return toView(updated!, true);
    });
  },

  /** Terminal for payroll purposes: a TERMINATED employee is excluded from every new pay run's employee picker — see `PayRunService.create`. */
  async terminate(actor: Actor, id: string, terminationDate: Date) {
    assertPermission(actor, "employee:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadEmployeeOr404(tx, actor.organizationId, id);
      if (existing.status !== "ACTIVE") throw new EmployeeNotActiveError(existing.name);

      const [updated] = await tx
        .update(employees)
        .set({ status: "TERMINATED", terminationDate, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(employees.id, id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "employee.terminated",
        entityType: "Employee",
        entityId: id,
        before: { status: "ACTIVE" },
        after: { status: "TERMINATED", terminationDate: terminationDate.toISOString().slice(0, 10) },
      });

      return toView(updated!, true);
    });
  },
};

function roleCanManage(actor: Actor): boolean {
  // Local re-check (not assertPermission, which would throw) purely to
  // decide whether to include the real tfn value on a read — see this
  // module's doc comment.
  try {
    assertPermission(actor, "employee:manage");
    return true;
  } catch {
    return false;
  }
}
