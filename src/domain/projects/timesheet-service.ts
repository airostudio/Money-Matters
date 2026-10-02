import { and, asc, desc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { projectTasks, projects, timesheetEntries, type timesheetEntryStatusEnum } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { AuditService } from "@/domain/audit/audit-service";
import { calculateDurationHours } from "./time-calculations";
import { loadProjectOr404 } from "./project-service";
import {
  InvalidTimesheetEntryError,
  NoRunningTimerError,
  ProjectNotActiveError,
  ProjectTaskBelongsToAnotherProjectError,
  ProjectTaskNotFoundError,
  TimerAlreadyRunningError,
  TimesheetEntryForbiddenError,
  TimesheetEntryNotDraftError,
  TimesheetEntryNotEditableError,
  TimesheetEntryNotFoundError,
  TimesheetEntryNotSubmittedError,
} from "./errors";
import type { CreateManualTimesheetEntryInput, UpdateTimesheetEntryInput } from "./types";

type TimesheetEntryStatus = (typeof timesheetEntryStatusEnum.enumValues)[number];

/** Once SUBMITTED, APPROVED or INVOICED, an entry can no longer be freely edited — see `timesheet_entry_status`'s schema comment. REJECTED reopens it for correction and resubmission. */
const EDITABLE_STATUSES: TimesheetEntryStatus[] = ["DRAFT", "REJECTED"];

function isApprover(actor: Actor): boolean {
  return roleHasPermission(actor.role, "timesheet:approve");
}

function assertOwnsOrApprover(actor: Actor, employeeUserId: string) {
  if (actor.userId !== employeeUserId && !isApprover(actor)) {
    throw new TimesheetEntryForbiddenError();
  }
}

async function assertProjectActive(tx: TenantDb, organizationId: string, projectId: string) {
  const project = await loadProjectOr404(tx, organizationId, projectId);
  if (project.status !== "ACTIVE") throw new ProjectNotActiveError(project.code);
  return project;
}

async function assertTaskBelongsToProject(tx: TenantDb, organizationId: string, projectId: string, taskId: string) {
  const [task] = await tx
    .select()
    .from(projectTasks)
    .where(and(eq(projectTasks.id, taskId), eq(projectTasks.organizationId, organizationId)));
  if (!task) throw new ProjectTaskNotFoundError(taskId);
  if (task.projectId !== projectId) throw new ProjectTaskBelongsToAnotherProjectError(taskId);
  return task;
}

async function loadEntryOr404(tx: TenantDb, organizationId: string, entryId: string) {
  const [entry] = await tx
    .select()
    .from(timesheetEntries)
    .where(and(eq(timesheetEntries.id, entryId), eq(timesheetEntries.organizationId, organizationId)));
  if (!entry) throw new TimesheetEntryNotFoundError(entryId);
  return entry;
}

function validateHours(hours: string) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidTimesheetEntryError("Hours must be a positive number.");
  }
}

export const TimesheetService = {
  /** Non-approvers only see their own entries; approvers can see everyone's. */
  async list(
    actor: Actor,
    opts: { projectId?: string; status?: TimesheetEntryStatus; mine?: boolean } = {},
  ) {
    assertPermission(actor, "timesheet:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(timesheetEntries.organizationId, actor.organizationId)];
      if (opts.projectId) conditions.push(eq(timesheetEntries.projectId, opts.projectId));
      if (opts.status) conditions.push(eq(timesheetEntries.status, opts.status));
      if (opts.mine || !isApprover(actor)) conditions.push(eq(timesheetEntries.employeeUserId, actor.userId));

      const rows = await tx
        .select({ entry: timesheetEntries, project: projects, task: projectTasks })
        .from(timesheetEntries)
        .innerJoin(projects, eq(projects.id, timesheetEntries.projectId))
        .leftJoin(projectTasks, eq(projectTasks.id, timesheetEntries.taskId))
        .where(and(...conditions))
        .orderBy(desc(timesheetEntries.entryDate), desc(timesheetEntries.createdAt));

      return rows.map((r) => ({ ...r.entry, project: r.project, task: r.task }));
    });
  },

  async get(actor: Actor, entryId: string) {
    assertPermission(actor, "timesheet:read");
    return withTenant(actor.organizationId, async (tx) => {
      const entry = await loadEntryOr404(tx, actor.organizationId, entryId);
      assertOwnsOrApprover(actor, entry.employeeUserId);
      return entry;
    });
  },

  /** True if this employee has a timer currently running (an entry with `startedAt` set and `endedAt` null). */
  async getRunningTimer(actor: Actor, employeeUserId: string) {
    assertPermission(actor, "timesheet:read");
    assertOwnsOrApprover(actor, employeeUserId);
    return withTenant(actor.organizationId, async (tx) => {
      const [running] = await tx
        .select()
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.organizationId, actor.organizationId),
            eq(timesheetEntries.employeeUserId, employeeUserId),
            isNotNull(timesheetEntries.startedAt),
            isNull(timesheetEntries.endedAt),
          ),
        );
      return running ?? null;
    });
  },

  /** Manual time entry — `hours` supplied directly, no `startedAt`/`endedAt`. */
  async createManual(actor: Actor, input: CreateManualTimesheetEntryInput) {
    assertPermission(actor, "timesheet:manage");
    assertOwnsOrApprover(actor, input.employeeUserId);
    validateHours(input.hours);
    return withTenant(actor.organizationId, async (tx) => {
      await assertProjectActive(tx, actor.organizationId, input.projectId);
      if (input.taskId) await assertTaskBelongsToProject(tx, actor.organizationId, input.projectId, input.taskId);

      const [created] = await tx
        .insert(timesheetEntries)
        .values({
          organizationId: actor.organizationId,
          employeeUserId: input.employeeUserId,
          projectId: input.projectId,
          taskId: input.taskId ?? null,
          entryDate: input.entryDate,
          hours: input.hours,
          notes: input.notes ?? null,
          billable: input.billable ?? true,
          status: "DRAFT",
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create timesheet entry.");

      await AuditService.record(tx, actor, {
        action: "timesheet_entry.created",
        entityType: "TimesheetEntry",
        entityId: created.id,
        after: { projectId: input.projectId, hours: input.hours, method: "manual" },
      });

      return created;
    });
  },

  /** Starts a running timer for this employee against a project/task. Refuses if one is already running — stop it first (master spec §23). */
  async startTimer(
    actor: Actor,
    input: { employeeUserId: string; projectId: string; taskId?: string; notes?: string; billable?: boolean },
  ) {
    assertPermission(actor, "timesheet:manage");
    assertOwnsOrApprover(actor, input.employeeUserId);
    return withTenant(actor.organizationId, async (tx) => {
      await assertProjectActive(tx, actor.organizationId, input.projectId);
      if (input.taskId) await assertTaskBelongsToProject(tx, actor.organizationId, input.projectId, input.taskId);

      const [existing] = await tx
        .select()
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.organizationId, actor.organizationId),
            eq(timesheetEntries.employeeUserId, input.employeeUserId),
            isNotNull(timesheetEntries.startedAt),
            isNull(timesheetEntries.endedAt),
          ),
        );
      if (existing) throw new TimerAlreadyRunningError();

      const now = new Date();
      const [created] = await tx
        .insert(timesheetEntries)
        .values({
          organizationId: actor.organizationId,
          employeeUserId: input.employeeUserId,
          projectId: input.projectId,
          taskId: input.taskId ?? null,
          entryDate: now,
          hours: "0.00",
          startedAt: now,
          notes: input.notes ?? null,
          billable: input.billable ?? true,
          status: "DRAFT",
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to start timer.");

      await AuditService.record(tx, actor, {
        action: "timesheet_entry.timer_started",
        entityType: "TimesheetEntry",
        entityId: created.id,
        after: { projectId: input.projectId, startedAt: now.toISOString() },
      });

      return created;
    });
  },

  /** Stops this employee's running timer and fills in `hours` from the elapsed duration. */
  async stopTimer(actor: Actor, employeeUserId: string) {
    assertPermission(actor, "timesheet:manage");
    assertOwnsOrApprover(actor, employeeUserId);
    return withTenant(actor.organizationId, async (tx) => {
      const [running] = await tx
        .select()
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.organizationId, actor.organizationId),
            eq(timesheetEntries.employeeUserId, employeeUserId),
            isNotNull(timesheetEntries.startedAt),
            isNull(timesheetEntries.endedAt),
          ),
        );
      if (!running || !running.startedAt) throw new NoRunningTimerError();

      const endedAt = new Date();
      const hours = calculateDurationHours(running.startedAt, endedAt);

      const [updated] = await tx
        .update(timesheetEntries)
        .set({ endedAt, hours, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(timesheetEntries.id, running.id))
        .returning();

      await AuditService.record(tx, actor, {
        action: "timesheet_entry.timer_stopped",
        entityType: "TimesheetEntry",
        entityId: running.id,
        after: { hours },
      });

      return updated;
    });
  },

  async update(actor: Actor, entryId: string, input: UpdateTimesheetEntryInput) {
    assertPermission(actor, "timesheet:manage");
    validateHours(input.hours);
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadEntryOr404(tx, actor.organizationId, entryId);
      assertOwnsOrApprover(actor, existing.employeeUserId);
      if (!EDITABLE_STATUSES.includes(existing.status)) throw new TimesheetEntryNotEditableError(entryId);
      await assertProjectActive(tx, actor.organizationId, input.projectId);
      if (input.taskId) await assertTaskBelongsToProject(tx, actor.organizationId, input.projectId, input.taskId);

      const [updated] = await tx
        .update(timesheetEntries)
        .set({
          projectId: input.projectId,
          taskId: input.taskId ?? null,
          entryDate: input.entryDate,
          hours: input.hours,
          notes: input.notes ?? null,
          billable: input.billable ?? true,
          // A correction after rejection goes back to DRAFT and must be resubmitted.
          status: "DRAFT",
          rejectedAt: null,
          rejectedById: null,
          rejectionReason: null,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(timesheetEntries.id, entryId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "timesheet_entry.updated",
        entityType: "TimesheetEntry",
        entityId: entryId,
        before: { hours: existing.hours, status: existing.status },
        after: { hours: input.hours, status: "DRAFT" },
      });

      return updated;
    });
  },

  async deleteDraft(actor: Actor, entryId: string) {
    assertPermission(actor, "timesheet:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadEntryOr404(tx, actor.organizationId, entryId);
      assertOwnsOrApprover(actor, existing.employeeUserId);
      if (!EDITABLE_STATUSES.includes(existing.status)) throw new TimesheetEntryNotEditableError(entryId);
      await tx.delete(timesheetEntries).where(eq(timesheetEntries.id, entryId));
      await AuditService.record(tx, actor, {
        action: "timesheet_entry.deleted",
        entityType: "TimesheetEntry",
        entityId: entryId,
        before: { hours: existing.hours },
      });
    });
  },

  async submit(actor: Actor, entryId: string) {
    assertPermission(actor, "timesheet:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const entry = await loadEntryOr404(tx, actor.organizationId, entryId);
      assertOwnsOrApprover(actor, entry.employeeUserId);
      if (!EDITABLE_STATUSES.includes(entry.status)) throw new TimesheetEntryNotDraftError(entryId);
      if (entry.startedAt && !entry.endedAt) {
        throw new InvalidTimesheetEntryError("Stop the running timer before submitting this entry.");
      }

      const [updated] = await tx
        .update(timesheetEntries)
        .set({
          status: "SUBMITTED",
          submittedAt: new Date(),
          submittedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(timesheetEntries.id, entryId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "timesheet_entry.submitted",
        entityType: "TimesheetEntry",
        entityId: entryId,
        before: { status: entry.status },
        after: { status: "SUBMITTED" },
      });

      return updated;
    });
  },

  /** A manager's single-approver decision — same pattern as `ExpenseClaimService.approve`, a distinct permission from `timesheet:manage` so an employee can never approve their own time. */
  async approve(actor: Actor, entryId: string) {
    assertPermission(actor, "timesheet:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const entry = await loadEntryOr404(tx, actor.organizationId, entryId);
      if (entry.status !== "SUBMITTED") throw new TimesheetEntryNotSubmittedError(entryId);

      const [updated] = await tx
        .update(timesheetEntries)
        .set({
          status: "APPROVED",
          approvedAt: new Date(),
          approvedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(timesheetEntries.id, entryId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "timesheet_entry.approved",
        entityType: "TimesheetEntry",
        entityId: entryId,
        before: { status: "SUBMITTED" },
        after: { status: "APPROVED" },
      });

      return updated;
    });
  },

  async reject(actor: Actor, entryId: string, reason: string) {
    assertPermission(actor, "timesheet:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const entry = await loadEntryOr404(tx, actor.organizationId, entryId);
      if (entry.status !== "SUBMITTED") throw new TimesheetEntryNotSubmittedError(entryId);

      const [updated] = await tx
        .update(timesheetEntries)
        .set({
          status: "REJECTED",
          rejectedAt: new Date(),
          rejectedById: actor.userId,
          rejectionReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(timesheetEntries.id, entryId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "timesheet_entry.rejected",
        entityType: "TimesheetEntry",
        entityId: entryId,
        before: { status: "SUBMITTED" },
        after: { status: "REJECTED", reason },
      });

      return updated;
    });
  },

  /**
   * Approved, billable, not-yet-invoiced entries for a project within an
   * optional date range — the exact selection
   * `ProjectTimeBillingService.createInvoiceFromUnbilledTime` bills, exposed
   * separately so a project's UI can preview what an invoice run would pick
   * up before actually creating one. See `selectUnbilledEntries` in
   * `time-calculations.ts` for the pure-function version of this same rule,
   * unit-tested independently.
   */
  async listUnbilled(actor: Actor, projectId: string, opts: { from?: Date; to?: Date } = {}) {
    assertPermission(actor, "timesheet:read");
    return withTenant(actor.organizationId, (tx) => queryUnbilledEntries(tx, actor.organizationId, projectId, opts));
  },
};

export async function queryUnbilledEntries(
  tx: TenantDb,
  organizationId: string,
  projectId: string,
  opts: { from?: Date; to?: Date } = {},
) {
  const conditions = [
    eq(timesheetEntries.organizationId, organizationId),
    eq(timesheetEntries.projectId, projectId),
    eq(timesheetEntries.status, "APPROVED"),
    eq(timesheetEntries.billable, true),
    isNull(timesheetEntries.invoiceId),
  ];
  if (opts.from) conditions.push(gte(timesheetEntries.entryDate, opts.from));
  if (opts.to) conditions.push(lte(timesheetEntries.entryDate, opts.to));

  return tx
    .select({ entry: timesheetEntries, task: projectTasks })
    .from(timesheetEntries)
    .leftJoin(projectTasks, eq(projectTasks.id, timesheetEntries.taskId))
    .where(and(...conditions))
    .orderBy(asc(timesheetEntries.entryDate));
}
