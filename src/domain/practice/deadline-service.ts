import { and, asc, eq } from "drizzle-orm";
import { practiceClientLinks, practiceDeadlineTemplates, practiceTasks } from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { PracticeAccess } from "./practice-access";
import { PracticeAuditService } from "./practice-audit";
import { ClientLinkNotFoundError, PracticeValidationError } from "./errors";
import { nextOccurrences, validateRule, type DeadlineRule } from "./tax-calendar";
import type { PracticeActor } from "./types";
import type { TaskCategory, TaskPriority } from "./task-service";

export interface DeadlineTemplateInput extends DeadlineRule {
  name: string;
  category?: TaskCategory;
  priority?: TaskPriority;
  /** Per client, or null for a practice-wide deadline. */
  clientOrganizationId?: string | null;
  notes?: string;
}

export interface DeadlineTemplateView extends DeadlineRule {
  id: string;
  name: string;
  category: TaskCategory;
  priority: TaskPriority;
  clientOrganizationId: string | null;
  clientName: string | null;
  notes: string | null;
  isActive: boolean;
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new PracticeValidationError("A deadline template needs a name.");
  if (name.length > 160) throw new PracticeValidationError("A template name must be 160 characters or fewer.");
  return name;
}

/**
 * The practice's own recurring-deadline rules ("tax calendar"). The user writes
 * the rule; the system only does date arithmetic on it (tax-calendar.ts) and
 * turns the next occurrences into ordinary practice tasks ON DEMAND — there is
 * no job queue, so nothing generates in the background. Generating twice is
 * harmless: a task is unique per (template, period end).
 */
export const DeadlineService = {
  async listTemplates(actor: PracticeActor, practiceId: string): Promise<DeadlineTemplateView[]> {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.load(tx, actor, practiceId);
      const rows = await tx
        .select({ t: practiceDeadlineTemplates, clientName: practiceClientLinks.clientName })
        .from(practiceDeadlineTemplates)
        .leftJoin(
          practiceClientLinks,
          and(
            eq(practiceClientLinks.practiceId, practiceDeadlineTemplates.practiceId),
            eq(practiceClientLinks.clientOrganizationId, practiceDeadlineTemplates.clientOrganizationId),
          ),
        )
        .where(eq(practiceDeadlineTemplates.practiceId, practiceId))
        .orderBy(asc(practiceDeadlineTemplates.name));
      return rows.map(({ t, clientName }) => toView(t, clientName));
    });
  },

  async createTemplate(actor: PracticeActor, practiceId: string, input: DeadlineTemplateInput): Promise<DeadlineTemplateView> {
    const name = cleanName(input.name);
    validateRule(input);
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Defining a deadline template");
      await assertClient(tx, practiceId, input.clientOrganizationId);
      const [row] = await tx
        .insert(practiceDeadlineTemplates)
        .values({
          practiceId,
          clientOrganizationId: input.clientOrganizationId ?? null,
          name,
          category: input.category ?? "BAS",
          frequency: input.frequency,
          periodEndMonth: input.periodEndMonth,
          dueMonthsAfter: input.dueMonthsAfter,
          dueDay: input.dueDay,
          priority: input.priority ?? "NORMAL",
          notes: input.notes?.trim() || null,
          createdByUserId: actor.userId,
        })
        .returning();
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "deadline_template.created",
        entityType: "DeadlineTemplate",
        entityId: row!.id,
        after: { name, frequency: input.frequency, periodEndMonth: input.periodEndMonth, dueMonthsAfter: input.dueMonthsAfter, dueDay: input.dueDay },
      });
      return toView(row!, null);
    });
  },

  async updateTemplate(actor: PracticeActor, practiceId: string, templateId: string, patch: Partial<DeadlineTemplateInput> & { isActive?: boolean }) {
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Editing a deadline template");
      const [before] = await tx
        .select()
        .from(practiceDeadlineTemplates)
        .where(and(eq(practiceDeadlineTemplates.id, templateId), eq(practiceDeadlineTemplates.practiceId, practiceId)));
      if (!before) throw new PracticeValidationError("That deadline template does not exist.");
      const merged: DeadlineRule = {
        frequency: patch.frequency ?? before.frequency,
        periodEndMonth: patch.periodEndMonth ?? before.periodEndMonth,
        dueMonthsAfter: patch.dueMonthsAfter ?? before.dueMonthsAfter,
        dueDay: patch.dueDay ?? before.dueDay,
      };
      validateRule(merged);
      await tx
        .update(practiceDeadlineTemplates)
        .set({
          ...merged,
          ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
          ...(patch.category !== undefined ? { category: patch.category } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes.trim() || null } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(practiceDeadlineTemplates.id, templateId));
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: patch.isActive === false ? "deadline_template.deactivated" : "deadline_template.updated",
        entityType: "DeadlineTemplate",
        entityId: templateId,
        before: { name: before.name, frequency: before.frequency, periodEndMonth: before.periodEndMonth, dueMonthsAfter: before.dueMonthsAfter, dueDay: before.dueDay, isActive: before.isActive },
        after: { ...merged, isActive: patch.isActive ?? before.isActive },
      });
    });
  },

  /**
   * MANAGER+. Creates the tasks for the next `occurrences` deadlines (default 3) of every ACTIVE
   * template (or just `templateId`), skipping any already generated. `today` is injectable for
   * tests; the default is the real date. Returns how many tasks were created.
   */
  async generate(
    actor: PracticeActor,
    practiceId: string,
    opts: { templateId?: string; occurrences?: number; today?: string } = {},
  ): Promise<{ created: number; templates: number }> {
    const today = opts.today ?? new Date().toISOString().slice(0, 10);
    const occurrences = opts.occurrences ?? 3;
    return withUserScope(actor.userId, async (tx) => {
      await PracticeAccess.require(tx, actor, practiceId, "MANAGER", "Generating deadline tasks");
      const templates = await tx
        .select()
        .from(practiceDeadlineTemplates)
        .where(
          and(
            eq(practiceDeadlineTemplates.practiceId, practiceId),
            eq(practiceDeadlineTemplates.isActive, true),
            ...(opts.templateId ? [eq(practiceDeadlineTemplates.id, opts.templateId)] : []),
          ),
        );
      let created = 0;
      for (const t of templates) {
        let assignee: string | null = null;
        if (t.clientOrganizationId) {
          const [link] = await tx
            .select({ assignedUserId: practiceClientLinks.assignedUserId })
            .from(practiceClientLinks)
            .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, t.clientOrganizationId)));
          assignee = link?.assignedUserId ?? null;
        }
        for (const occ of nextOccurrences(t, today, occurrences)) {
          const inserted = await tx
            .insert(practiceTasks)
            .values({
              practiceId,
              clientOrganizationId: t.clientOrganizationId,
              title: `${t.name} — period ending ${occ.periodEnd}`,
              description: t.notes,
              dueDate: occ.dueDate,
              priority: t.priority,
              category: t.category,
              assignedUserId: assignee,
              createdByUserId: actor.userId,
              templateId: t.id,
              periodEnd: occ.periodEnd,
            })
            .onConflictDoNothing()
            .returning({ id: practiceTasks.id });
          created += inserted.length;
        }
      }
      await PracticeAuditService.record(tx, {
        practiceId,
        actorUserId: actor.userId,
        actorType: actor.type,
        action: "deadline_template.generated",
        entityType: "DeadlineTemplate",
        entityId: opts.templateId ?? "all",
        after: { created, templates: templates.length, from: today, occurrences },
      });
      return { created, templates: templates.length };
    });
  },
};

async function assertClient(tx: UserScopeDb, practiceId: string, clientOrganizationId: string | null | undefined) {
  if (!clientOrganizationId) return;
  const [link] = await tx
    .select({ id: practiceClientLinks.id })
    .from(practiceClientLinks)
    .where(and(eq(practiceClientLinks.practiceId, practiceId), eq(practiceClientLinks.clientOrganizationId, clientOrganizationId)));
  if (!link) throw new ClientLinkNotFoundError();
}

function toView(t: typeof practiceDeadlineTemplates.$inferSelect, clientName: string | null): DeadlineTemplateView {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    priority: t.priority,
    frequency: t.frequency,
    periodEndMonth: t.periodEndMonth,
    dueMonthsAfter: t.dueMonthsAfter,
    dueDay: t.dueDay,
    clientOrganizationId: t.clientOrganizationId,
    clientName,
    notes: t.notes,
    isActive: t.isActive,
  };
}
