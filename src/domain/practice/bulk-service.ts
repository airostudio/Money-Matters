import { withUserScope } from "@/db/user-scope";
import { assignWithin } from "./client-link-service";
import { ClientGroupService } from "./client-group-service";
import { PracticeConsentService } from "./consent-service";
import { HealthService, type RefreshResult } from "./health-service";
import { TaskService, type TaskInput } from "./task-service";
import { BulkSelectionError } from "./errors";
import { MAX_BULK_SELECTION, type PracticeActor } from "./types";

function bounded(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length < 1 || unique.length > MAX_BULK_SELECTION) throw new BulkSelectionError();
  return unique;
}

/**
 * Bulk actions on the dashboard selection (master spec s.42). Every one is bounded
 * to one page (MAX_BULK_SELECTION clients) and sequential; none fans out in
 * parallel. Assign, apply-group and create-task each run as ONE user-scoped
 * transaction touching only the practice's own tables (no client data is read);
 * refresh runs one client at a time, each with the staff member's real role there.
 */
export const BulkService = {
  /** MANAGER+. Assigns (or clears, with null) the responsible staff member for every selected client. */
  async assign(actor: PracticeActor, practiceId: string, clientOrganizationIds: string[], assigneeUserId: string | null): Promise<number> {
    const ids = bounded(clientOrganizationIds);
    await withUserScope(actor.userId, (tx) => assignWithin(tx, actor, practiceId, ids, assigneeUserId));
    // The informational notes in each ACTIVE client's own audit log, one short transaction after another.
    for (const id of ids) {
      await PracticeConsentService.recordNoteIfActive(id, practiceId, actor.userId, "practice_link.staff_assigned", practiceId);
    }
    return ids.length;
  },

  async applyGroup(actor: PracticeActor, practiceId: string, groupId: string, clientOrganizationIds: string[]): Promise<number> {
    return ClientGroupService.apply(actor, practiceId, groupId, bounded(clientOrganizationIds));
  },

  async createTask(actor: PracticeActor, practiceId: string, clientOrganizationIds: string[], input: Omit<TaskInput, "clientOrganizationId">): Promise<number> {
    return TaskService.bulkCreate(actor, practiceId, bounded(clientOrganizationIds), input);
  },

  async refresh(actor: PracticeActor, practiceId: string, clientOrganizationIds: string[], now?: Date): Promise<RefreshResult[]> {
    return HealthService.refreshMany(actor, practiceId, bounded(clientOrganizationIds), now);
  },
};
