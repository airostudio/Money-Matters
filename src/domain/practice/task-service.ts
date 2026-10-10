import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { practiceClientLinks, practiceTasks, users } from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { PracticeAccess, practiceRoleAtLeast, type PracticeContext } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import { BulkSelectionError, ClientLinkNotFoundError, InvalidAssigneeError, PracticeValidationError, TaskNotFoundError } from "./errors";
import { MAX_BULK_SELECTION, type PracticeActor } from "./types";

export type TaskStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export type TaskPriority = "LOW" | "NORMAL" | "HIGH";
export type TaskCategory = "BAS" | "TAX" | "PAYROLL" | "YEAR_END" | "REVIEW" | "BOOKKEEPING" | "OTHER";

export const TASK_CATEGORIES: TaskCategory[] = ["BAS", "TAX", "PAYROLL", "YEAR_END", "REVIEW", "BOOKKEEPING", "OTHER"];

export interface TaskInput {
  title: string;
  description?: string;
  /** YYYY-MM-DD. */
  dueDate?: string | null;
  clientOrganizationId?: string | null;
  assignedUserId?: string | null;
  priority?: TaskPriority;
  category?: TaskCategory;
}

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  category: TaskCategory;
  clientOrganizationId: string | null;
  clientName: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  createdByUserId: string;
  completedAt: string | null;
  fromTemplate: boolean;
}

export interface TaskFilter {
  /** "open" = OPEN + IN_PROGRESS; "all" includes DONE/CANCELLED. Default open. */
  status?: "open" | "all";
  clientOrganizationId?: string;
  assignedUserId?: string;
  category?: TaskCategory;
  dueFrom?: string;
  dueTo?: string;
  /** Always capped (default 200). */
  limit?: number;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function cleanTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new PracticeValidationError("A task needs a title.");
  if (title.length > 200) throw new PracticeValidationError("A task title must be 200 characters or fewer.");
  return title;
}

function cleanDate(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!YMD.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new PracticeValidationError("Dates must be YYYY-MM-DD.");
  return raw;
}

async function assertLink(tx: UserScopeDb, practiceId: string, clientOrganizationId: string) {
  const [link] = await tx
    .select({ id: practiceClientLinks.id })
    .from(practiceClientLinks)
    .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, clientOrganizationId)));
  if (!link) throw new ClientLinkNotFoundError();
}

/**
 * Practice-owned tasks (master spec s.42): internal to the practice — a client
 * never sees them (they live in practice-scoped tables, not in any tenant).
 * Anyone in the practice may create a task and update one they created or are
 * assigned; MANAGER+ may update any task and assign work to others. Every
 * mutation is audited. Tasks survive a client revoking access (they are the
 * practice's own record).
 */
export const TaskService = {
  async create(actor: PracticeActor, practiceId: string, input: TaskInput): Promise<TaskView> {
    const title = cleanTitle(input.title);
    const dueDate = cleanDate(input.dueDate);
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      await checkRefs(tx, ctx, practiceId, input);
      const [row] = await tx
        .insert(practiceTasks)
        .values({
          practiceId,
          title,
          description: input.description?.trim() || null,
          dueDate,
          clientOrganizationId: input.clientOrganizationId ?? null,
          assignedUserId: input.assignedUserId ?? null,
          priority: input.priority ?? "NORMAL",
          category: input.category ?? "OTHER",
          createdByUserId: actor.userId,
        })
        .returning();
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "practice_task.created",
        entityType: "PracticeTask",
        entityId: row!.id,
        after: { title, dueDate, clientOrganizationId: input.clientOrganizationId ?? null, assignedUserId: input.assignedUserId ?? null },
      });
      return (await loadViews(tx, practiceId, [row!.id]))[0]!;
    });
  },

  /** MANAGER+. One task per selected client (at most one page), in ONE transaction; no client data is read. */
  async bulkCreate(actor: PracticeActor, practiceId: string, clientOrganizationIds: string[], input: Omit<TaskInput, "clientOrganizationId">) {
    const ids = [...new Set(clientOrganizationIds)];
    if (ids.length < 1 || ids.length > MAX_BULK_SELECTION) throw new BulkSelectionError();
    const title = cleanTitle(input.title);
    const dueDate = cleanDate(input.dueDate);
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Creating tasks across clients");
      await checkRefs(tx, ctx, practiceId, { ...input, clientOrganizationId: null });
      const created: string[] = [];
      for (const clientOrganizationId of ids) {
        await assertLink(tx, practiceId, clientOrganizationId);
        const [row] = await tx
          .insert(practiceTasks)
          .values({
            practiceId,
            title,
            description: input.description?.trim() || null,
            dueDate,
            clientOrganizationId,
            assignedUserId: input.assignedUserId ?? null,
            priority: input.priority ?? "NORMAL",
            category: input.category ?? "OTHER",
            createdByUserId: actor.userId,
          })
          .returning({ id: practiceTasks.id });
        created.push(row!.id);
      }
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "practice_task.bulk_created",
        entityType: "PracticeTask",
        entityId: created[0]!,
        after: { title, dueDate, count: created.length, clientOrganizationIds: ids },
      });
      return created.length;
    });
  },

  async update(
    actor: PracticeActor,
    practiceId: string,
    taskId: string,
    patch: Partial<Omit<TaskInput, "clientOrganizationId">> & { status?: TaskStatus },
  ): Promise<TaskView> {
    return withUserScope(actor.userId, async (tx) => {
      const ctx = await PracticeAccess.load(tx, actor, practiceId);
      const before = await loadTask(tx, practiceId, taskId);
      const isManager = practiceRoleAtLeast(ctx.role, "MANAGER");
      const involved = before.createdByUserId === actor.userId || before.assignedUserId === actor.userId;
      if (!isManager && !involved) {
        await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Changing a task you neither created nor are assigned");
      }
      const set: Partial<typeof practiceTasks.$inferInsert> = { updatedAt: new Date() };
      if (patch.title !== undefined) set.title = cleanTitle(patch.title);
      if (patch.description !== undefined) set.description = patch.description.trim() || null;
      if (patch.dueDate !== undefined) set.dueDate = cleanDate(patch.dueDate);
      if (patch.priority !== undefined) set.priority = patch.priority;
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.assignedUserId !== undefined && patch.assignedUserId !== before.assignedUserId) {
        if (!isManager && patch.assignedUserId !== actor.userId) {
          await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Assigning a task to someone else");
        }
        if (patch.assignedUserId && !(await PracticeAccess.isActiveMember(tx, practiceId, patch.assignedUserId))) throw new InvalidAssigneeError();
        set.assignedUserId = patch.assignedUserId;
      }
      if (patch.status !== undefined && patch.status !== before.status) {
        set.status = patch.status;
        if (patch.status === "DONE") {
          set.completedAt = new Date();
          set.completedByUserId = actor.userId;
        } else {
          set.completedAt = null;
          set.completedByUserId = null;
        }
      }
      await tx.update(practiceTasks).set(set).where(eq(practiceTasks.id, taskId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: patch.status && patch.status !== before.status ? `practice_task.${patch.status.toLowerCase()}` : "practice_task.updated",
        entityType: "PracticeTask",
        entityId: taskId,
        before: { title: before.title, status: before.status, dueDate: before.dueDate, assignedUserId: before.assignedUserId },
        after: { ...set, updatedAt: undefined },
      });
      return (await loadViews(tx, practiceId, [taskId]))[0]!;
    });
  },

  async complete(actor: PracticeActor, practiceId: string, taskId: string) {
    return TaskService.update(actor, practiceId, taskId, { status: "DONE" });
  },

  async list(actor: PracticeActor, practiceId: string, filter: TaskFilter = {}): Promise<TaskView[]> {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const conds: SQL[] = [eq(practiceTasks.practiceId, practiceId)];
      if ((filter.status ?? "open") === "open") conds.push(inArray(practiceTasks.status, ["OPEN", "IN_PROGRESS"]));
      if (filter.clientOrganizationId) conds.push(eq(practiceTasks.clientOrganizationId, filter.clientOrganizationId));
      if (filter.assignedUserId) conds.push(eq(practiceTasks.assignedUserId, filter.assignedUserId));
      if (filter.category) conds.push(eq(practiceTasks.category, filter.category));
      if (filter.dueFrom) conds.push(gte(practiceTasks.dueDate, filter.dueFrom));
      if (filter.dueTo) conds.push(lte(practiceTasks.dueDate, filter.dueTo));
      const rows = await tx
        .select({ id: practiceTasks.id })
        .from(practiceTasks)
        .where(and(...conds))
        .orderBy(sql`${practiceTasks.dueDate} asc nulls last`, desc(practiceTasks.priority), asc(practiceTasks.createdAt))
        .limit(Math.min(filter.limit ?? 200, 500));
      return loadViews(tx, practiceId, rows.map((r) => r.id));
    });
  },
};

async function checkRefs(tx: UserScopeDb, _ctx: PracticeContext, practiceId: string, input: TaskInput) {
  if (input.clientOrganizationId) await assertLink(tx, practiceId, input.clientOrganizationId);
  if (input.assignedUserId && !(await PracticeAccess.isActiveMember(tx, practiceId, input.assignedUserId))) throw new InvalidAssigneeError();
}

async function loadTask(tx: UserScopeDb, practiceId: string, taskId: string) {
  const [row] = await tx
    .select()
    .from(practiceTasks)
    .where(and(eq(practiceTasks.id, taskId), eq(practiceTasks.practiceId, practiceId)));
  if (!row) throw new TaskNotFoundError();
  return row;
}

/** Views for a set of task ids, preserving the order given. */
async function loadViews(tx: UserScopeDb, practiceId: string, ids: string[]): Promise<TaskView[]> {
  if (ids.length === 0) return [];
  const assignee = alias(users, "assignee");
  const rows = await tx
    .select({ task: practiceTasks, clientName: practiceClientLinks.clientName, assignedName: assignee.name })
    .from(practiceTasks)
    .leftJoin(
      practiceClientLinks,
      and(eq(practiceClientLinks.practiceId, practiceTasks.practiceId), eq(practiceClientLinks.clientOrganizationId, practiceTasks.clientOrganizationId)),
    )
    .leftJoin(assignee, eq(assignee.id, practiceTasks.assignedUserId))
    .where(and(eq(practiceTasks.practiceId, practiceId), inArray(practiceTasks.id, ids)));
  const views = new Map(
    rows.map(({ task, clientName, assignedName }) => [
      task.id,
      {
        id: task.id,
        title: task.title,
        description: task.description,
        dueDate: task.dueDate,
        status: task.status,
        priority: task.priority,
        category: task.category,
        clientOrganizationId: task.clientOrganizationId,
        clientName: clientName ?? null,
        assignedUserId: task.assignedUserId,
        assignedName: assignedName ?? null,
        createdByUserId: task.createdByUserId,
        completedAt: task.completedAt?.toISOString() ?? null,
        fromTemplate: Boolean(task.templateId),
      } satisfies TaskView,
    ]),
  );
  return ids.map((id) => views.get(id)).filter((v): v is TaskView => Boolean(v));
}

export { loadViews as loadTaskViews };
