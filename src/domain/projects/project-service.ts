import { and, asc, desc, eq } from "drizzle-orm";
import { contacts, projectTasks, projects, type projectStatusEnum } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import {
  InvalidContactForProjectError,
  ProjectAlreadyClosedError,
  ProjectCodeInUseError,
  ProjectNotFoundError,
  ProjectTaskBelongsToAnotherProjectError,
  ProjectTaskNotFoundError,
} from "./errors";
import type { CreateProjectInput, CreateProjectTaskInput, UpdateProjectInput, UpdateProjectTaskInput } from "./types";

type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];

const CLOSED_STATUSES: ProjectStatus[] = ["COMPLETED", "CANCELLED"];

async function assertCustomerUsable(tx: TenantDb, organizationId: string, contactId: string) {
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)));
  if (!contact || !contact.isActive || (contact.kind !== "CUSTOMER" && contact.kind !== "BOTH")) {
    throw new InvalidContactForProjectError(contactId);
  }
}

async function assertCodeAvailable(tx: TenantDb, organizationId: string, code: string, excludeId?: string) {
  const rows = await tx.select({ id: projects.id }).from(projects).where(
    and(eq(projects.organizationId, organizationId), eq(projects.code, code)),
  );
  if (rows.some((r) => r.id !== excludeId)) throw new ProjectCodeInUseError(code);
}

export async function loadProjectOr404(tx: TenantDb, organizationId: string, projectId: string) {
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)));
  if (!project) throw new ProjectNotFoundError(projectId);
  return project;
}

export const ProjectService = {
  async list(actor: Actor, opts: { status?: ProjectStatus } = {}) {
    assertPermission(actor, "project:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(projects.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(projects.status, opts.status));
      const rows = await tx
        .select({ project: projects, customer: contacts })
        .from(projects)
        .leftJoin(contacts, eq(contacts.id, projects.customerContactId))
        .where(and(...conditions))
        .orderBy(desc(projects.createdAt));
      return rows.map((r) => ({ ...r.project, customer: r.customer }));
    });
  },

  async get(actor: Actor, projectId: string) {
    assertPermission(actor, "project:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ project: projects, customer: contacts })
        .from(projects)
        .leftJoin(contacts, eq(contacts.id, projects.customerContactId))
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, actor.organizationId)));
      if (!row) return null;

      const tasks = await tx
        .select()
        .from(projectTasks)
        .where(eq(projectTasks.projectId, projectId))
        .orderBy(asc(projectTasks.createdAt));

      return { ...row.project, customer: row.customer, tasks };
    });
  },

  async create(actor: Actor, input: CreateProjectInput) {
    assertPermission(actor, "project:manage");
    return withTenant(actor.organizationId, async (tx) => {
      if (input.customerContactId) await assertCustomerUsable(tx, actor.organizationId, input.customerContactId);
      await assertCodeAvailable(tx, actor.organizationId, input.code);

      const [created] = await tx
        .insert(projects)
        .values({
          organizationId: actor.organizationId,
          customerContactId: input.customerContactId ?? null,
          code: input.code,
          name: input.name,
          currency: input.currency,
          budgetedRevenue: input.budgetedRevenue ?? "0",
          budgetedCost: input.budgetedCost ?? "0",
          defaultHourlyRate: input.defaultHourlyRate ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          memo: input.memo ?? null,
          status: "ACTIVE",
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!created) throw new Error("Failed to create project.");

      await AuditService.record(tx, actor, {
        action: "project.created",
        entityType: "Project",
        entityId: created.id,
        after: { code: created.code, name: created.name },
      });

      return created;
    });
  },

  async update(actor: Actor, projectId: string, input: UpdateProjectInput) {
    assertPermission(actor, "project:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadProjectOr404(tx, actor.organizationId, projectId);
      if (input.customerContactId) await assertCustomerUsable(tx, actor.organizationId, input.customerContactId);
      if (input.code !== existing.code) await assertCodeAvailable(tx, actor.organizationId, input.code, projectId);

      const [updated] = await tx
        .update(projects)
        .set({
          customerContactId: input.customerContactId ?? null,
          code: input.code,
          name: input.name,
          currency: input.currency,
          budgetedRevenue: input.budgetedRevenue ?? "0",
          budgetedCost: input.budgetedCost ?? "0",
          defaultHourlyRate: input.defaultHourlyRate ?? null,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          memo: input.memo ?? null,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "project.updated",
        entityType: "Project",
        entityId: projectId,
        before: { code: existing.code, name: existing.name },
        after: { code: input.code, name: input.name },
      });

      return updated;
    });
  },

  async setStatus(actor: Actor, projectId: string, status: ProjectStatus) {
    assertPermission(actor, "project:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadProjectOr404(tx, actor.organizationId, projectId);
      if (CLOSED_STATUSES.includes(existing.status) && status !== existing.status) {
        throw new ProjectAlreadyClosedError(existing.code);
      }

      const isClosing = CLOSED_STATUSES.includes(status);
      const [updated] = await tx
        .update(projects)
        .set({
          status,
          closedAt: isClosing ? new Date() : null,
          closedById: isClosing ? actor.userId : null,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "project.status_changed",
        entityType: "Project",
        entityId: projectId,
        before: { status: existing.status },
        after: { status },
      });

      return updated;
    });
  },

  async createTask(actor: Actor, projectId: string, input: CreateProjectTaskInput) {
    assertPermission(actor, "project:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await loadProjectOr404(tx, actor.organizationId, projectId);
      const [created] = await tx
        .insert(projectTasks)
        .values({
          organizationId: actor.organizationId,
          projectId,
          name: input.name,
          budgetedHours: input.budgetedHours ?? null,
          billingRate: input.billingRate ?? null,
        })
        .returning();
      if (!created) throw new Error("Failed to create project task.");

      await AuditService.record(tx, actor, {
        action: "project_task.created",
        entityType: "ProjectTask",
        entityId: created.id,
        after: { projectId, name: created.name },
      });

      return created;
    });
  },

  async updateTask(actor: Actor, projectId: string, taskId: string, input: UpdateProjectTaskInput) {
    assertPermission(actor, "project:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await loadProjectOr404(tx, actor.organizationId, projectId);
      const [task] = await tx
        .select()
        .from(projectTasks)
        .where(and(eq(projectTasks.id, taskId), eq(projectTasks.organizationId, actor.organizationId)));
      if (!task) throw new ProjectTaskNotFoundError(taskId);
      if (task.projectId !== projectId) throw new ProjectTaskBelongsToAnotherProjectError(taskId);

      const [updated] = await tx
        .update(projectTasks)
        .set({
          name: input.name,
          budgetedHours: input.budgetedHours ?? null,
          billingRate: input.billingRate ?? null,
          isDone: input.isDone ?? task.isDone,
          updatedAt: new Date(),
        })
        .where(eq(projectTasks.id, taskId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "project_task.updated",
        entityType: "ProjectTask",
        entityId: taskId,
        before: { name: task.name, isDone: task.isDone },
        after: { name: input.name, isDone: updated!.isDone },
      });

      return updated;
    });
  },
};
