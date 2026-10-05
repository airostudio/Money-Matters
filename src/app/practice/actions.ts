"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { PRACTICE_COOKIE, requireCurrentPractice, requirePracticeUser } from "./require-practice";
import { PracticeService } from "@/domain/practice/practice-service";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { ClientGroupService } from "@/domain/practice/client-group-service";
import { BulkService } from "@/domain/practice/bulk-service";
import { HealthService } from "@/domain/practice/health-service";
import { TaskService, type TaskCategory, type TaskPriority } from "@/domain/practice/task-service";
import { DeadlineService } from "@/domain/practice/deadline-service";
import { PracticeRequestService } from "@/domain/practice/practice-request-service";
import { WorkpaperService, type ScheduleLineInput } from "@/domain/practice/workpaper-service";
import type { PracticeRole } from "@/domain/practice/types";
import type { RequestType } from "@/domain/client-requests/client-request-service";

const str = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();
const all = (formData: FormData, key: string) => formData.getAll(key).map((v) => String(v)).filter(Boolean);

function go(path: string, kind: "error" | "notice", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}${kind}=${encodeURIComponent(message.slice(0, 600))}`);
}

/** Runs `fn`; a domain error becomes a visible banner on `path`, success revalidates it. */
async function run(path: string, fn: () => Promise<string | void>, revalidate: string[] = [path]): Promise<never> {
  let notice: string | void;
  try {
    notice = await fn();
  } catch (error) {
    go(path, "error", error instanceof Error ? error.message : "Something went wrong.");
  }
  for (const p of revalidate) revalidatePath(p.split("?")[0]!);
  return notice ? go(path, "notice", notice) : redirect(path);
}

// ------------------------------------------------------------------- practice

export async function createPracticeAction(formData: FormData): Promise<void> {
  const { actor } = await requirePracticeUser();
  let id = "";
  try {
    const practice = await PracticeService.create(actor, { name: str(formData, "name") });
    id = practice.id;
  } catch (error) {
    go("/practice", "error", error instanceof Error ? error.message : "Could not set up the practice.");
  }
  cookies().set(PRACTICE_COOKIE, id, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  revalidatePath("/practice");
  redirect("/practice");
}

export async function switchPracticeAction(formData: FormData): Promise<void> {
  const { actor } = await requirePracticeUser();
  const id = str(formData, "practiceId");
  const mine = await PracticeService.listMine(actor);
  if (mine.some((p) => p.id === id)) {
    cookies().set(PRACTICE_COOKIE, id, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  }
  redirect("/practice");
}

// ------------------------------------------------------------------ dashboard

/** Per-row "Refresh" (button value = that client) or the bulk "Refresh selected". Sequential, at most one page. */
export async function refreshAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  const only = str(formData, "only");
  const ids = only ? [only] : all(formData, "clientId");
  const back = str(formData, "back") || "/practice";
  await run(back, async () => {
    const results = await BulkService.refresh(actor, practice.id, ids);
    const ok = results.filter((r) => r.state === "OK").length;
    const problems = results.filter((r) => r.state !== "OK");
    return `Refreshed ${ok} of ${results.length}.${problems.length ? ` ${problems.map((p) => `${p.clientName || "A client"}: ${p.message ?? p.state}`).join(" · ")}` : ""}`;
  });
}

export async function bulkAssignAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  const back = str(formData, "back") || "/practice";
  await run(back, async () => {
    const assignee = str(formData, "assigneeUserId");
    const n = await BulkService.assign(actor, practice.id, all(formData, "clientId"), assignee || null);
    return `Updated the responsible staff member on ${n} client${n === 1 ? "" : "s"}.`;
  });
}

export async function bulkGroupAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  const back = str(formData, "back") || "/practice";
  await run(back, async () => {
    const n = await BulkService.applyGroup(actor, practice.id, str(formData, "groupId"), all(formData, "clientId"));
    return `Added ${n} client${n === 1 ? "" : "s"} to the group.`;
  });
}

export async function bulkTaskAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  const back = str(formData, "back") || "/practice";
  await run(back, async () => {
    const n = await BulkService.createTask(actor, practice.id, all(formData, "clientId"), {
      title: str(formData, "title"),
      dueDate: str(formData, "dueDate") || null,
      category: (str(formData, "category") || "OTHER") as TaskCategory,
      assignedUserId: str(formData, "assigneeUserId") || null,
    });
    return `Created ${n} task${n === 1 ? "" : "s"}.`;
  });
}

// -------------------------------------------------------------------- clients

export async function proposeLinkAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/clients", async () => {
    const link = await ClientLinkService.propose(actor, practice.id, str(formData, "slug"));
    return `Request sent to ${link.clientName}. It stays pending until that organization's owner or administrator accepts it from Settings > Accountant access.`;
  });
}

export async function verifyLinksAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/clients", async () => {
    const ids = all(formData, "clientId");
    const changes = await ClientLinkService.verify(actor, practice.id, ids);
    return changes.length ? `Updated ${changes.length} link${changes.length === 1 ? "" : "s"} from the clients' own records.` : "No changes: the clients' own records match.";
  });
}

export async function withdrawLinkAction(clientId: string): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/clients", async () => {
    await ClientLinkService.withdraw(actor, practice.id, clientId);
    return "The link has been ended. Your practice keeps its own tasks and workpapers for this client, marked as of today.";
  });
}

export async function assignClientAction(clientId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/clients", async () => {
    await ClientLinkService.assign(actor, practice.id, clientId, str(formData, "assigneeUserId") || null);
  });
}

export async function createGroupAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/clients", async () => {
    await ClientGroupService.create(actor, practice.id, str(formData, "name"));
  });
}

export async function deleteGroupAction(groupId: string): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/clients", async () => {
    await ClientGroupService.remove(actor, practice.id, groupId);
  });
}

// ---------------------------------------------------------------------- staff

export async function addStaffAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/staff", async () => {
    await PracticeService.addStaffByEmail(actor, practice.id, str(formData, "email"), str(formData, "role") as PracticeRole);
  });
}

export async function changeRoleAction(userId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/staff", async () => {
    await PracticeService.changeStaffRole(actor, practice.id, userId, str(formData, "role") as PracticeRole);
  });
}

export async function removeStaffAction(userId: string): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/staff", async () => {
    await PracticeService.removeStaff(actor, practice.id, userId);
  });
}

// ---------------------------------------------------------------------- tasks

export async function createTaskAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/tasks", async () => {
    await TaskService.create(actor, practice.id, {
      title: str(formData, "title"),
      description: str(formData, "description") || undefined,
      dueDate: str(formData, "dueDate") || null,
      clientOrganizationId: str(formData, "clientOrganizationId") || null,
      assignedUserId: str(formData, "assignedUserId") || null,
      priority: (str(formData, "priority") || "NORMAL") as TaskPriority,
      category: (str(formData, "category") || "OTHER") as TaskCategory,
    });
  });
}

export async function setTaskStatusAction(taskId: string, status: "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELLED", back: string): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(back, async () => {
    await TaskService.update(actor, practice.id, taskId, { status });
  });
}

// ------------------------------------------------------------------- calendar

export async function createTemplateAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/calendar", async () => {
    await DeadlineService.createTemplate(actor, practice.id, {
      name: str(formData, "name"),
      category: (str(formData, "category") || "BAS") as TaskCategory,
      frequency: str(formData, "frequency") as "MONTHLY" | "QUARTERLY" | "ANNUAL",
      periodEndMonth: Number(str(formData, "periodEndMonth")),
      dueMonthsAfter: Number(str(formData, "dueMonthsAfter")),
      dueDay: Number(str(formData, "dueDay")),
      clientOrganizationId: str(formData, "clientOrganizationId") || null,
      notes: str(formData, "notes") || undefined,
    });
  });
}

export async function toggleTemplateAction(templateId: string, active: boolean): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/calendar", async () => {
    await DeadlineService.updateTemplate(actor, practice.id, templateId, { isActive: active });
  });
}

export async function generateDeadlinesAction(): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run("/practice/calendar", async () => {
    const r = await DeadlineService.generate(actor, practice.id, {});
    return `Created ${r.created} task${r.created === 1 ? "" : "s"} from ${r.templates} active template${r.templates === 1 ? "" : "s"}.`;
  }, ["/practice/calendar", "/practice/tasks"]);
}

// ----------------------------------------------------------------- workpapers

export async function createWorkpaperAction(formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  let id = "";
  try {
    const created = await WorkpaperService.create(actor, practice.id, {
      clientOrganizationId: str(formData, "clientOrganizationId"),
      accountId: str(formData, "accountId"),
      periodEnd: str(formData, "periodEnd"),
    });
    id = created.id;
  } catch (error) {
    go(`/practice/workpapers/new?client=${encodeURIComponent(str(formData, "clientOrganizationId"))}`, "error", error instanceof Error ? error.message : "Could not create the workpaper.");
  }
  revalidatePath("/practice/workpapers");
  redirect(`/practice/workpapers/${id}`);
}

function wpPath(id: string) {
  return `/practice/workpapers/${id}`;
}

export async function setScheduleAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    const lines: ScheduleLineInput[] = [];
    for (let i = 0; i < 30; i += 1) {
      const description = str(formData, `description_${i}`);
      const amount = str(formData, `amount_${i}`);
      if (!description && !amount) continue;
      lines.push({
        kind: str(formData, `kind_${i}`) === "SUPPORTING_BALANCE" ? "SUPPORTING_BALANCE" : "RECONCILING_ITEM",
        description,
        reference: str(formData, `reference_${i}`) || undefined,
        amount: amount || "0",
        isRecurring: formData.get(`recurring_${i}`) === "on",
      });
    }
    const r = await WorkpaperService.setSchedule(actor, practice.id, workpaperId, lines);
    return `Schedule saved. Difference to the ledger: ${r.difference}.`;
  });
}

export async function addEvidenceAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a file to attach.");
    await WorkpaperService.addEvidence(actor, practice.id, workpaperId, {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      data: Buffer.from(await file.arrayBuffer()),
      description: str(formData, "description") || undefined,
    });
  });
}

export async function removeEvidenceAction(workpaperId: string, evidenceId: string): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.removeEvidence(actor, practice.id, workpaperId, evidenceId);
  });
}

export async function proposeAdjustmentAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.proposeAdjustment(actor, practice.id, workpaperId, {
      description: str(formData, "description"),
      amount: str(formData, "amount"),
      debitAccount: str(formData, "debitAccount") || undefined,
      creditAccount: str(formData, "creditAccount") || undefined,
    });
  });
}

export async function adjustmentStatusAction(workpaperId: string, adjustmentId: string, status: "PROPOSED" | "DISMISSED" | "POSTED", formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.setAdjustmentStatus(actor, practice.id, workpaperId, adjustmentId, status, str(formData, "postedReference") || undefined);
  });
}

export async function addNoteAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.addReviewNote(actor, practice.id, workpaperId, str(formData, "body"));
  });
}

export async function resolveNoteAction(workpaperId: string, noteId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.resolveReviewNote(actor, practice.id, workpaperId, noteId, str(formData, "comment") || undefined);
  });
}

export async function signPreparerAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.signAsPreparer(actor, practice.id, workpaperId, { acknowledgeDifference: formData.get("acknowledge") === "on" });
    return "Signed as preparer. The workpaper is now in review.";
  });
}

export async function signReviewerAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.signAsReviewer(actor, practice.id, workpaperId, { acknowledgeDifference: formData.get("acknowledge") === "on" });
    return "Signed off. The workpaper is now locked.";
  });
}

export async function reopenWorkpaperAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    const r = await WorkpaperService.reopen(actor, practice.id, workpaperId, str(formData, "reason"));
    return `Reopened as a draft (version ${r.version}).`;
  });
}

export async function refreshSnapshotAction(workpaperId: string): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(wpPath(workpaperId), async () => {
    await WorkpaperService.refreshSnapshot(actor, practice.id, workpaperId);
    return "A fresh balance was pulled from the client's ledger.";
  });
}

export async function carryForwardAction(workpaperId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  let id = "";
  try {
    const r = await WorkpaperService.carryForward(actor, practice.id, workpaperId, { periodEnd: str(formData, "periodEnd") || undefined });
    id = r.id;
  } catch (error) {
    go(wpPath(workpaperId), "error", error instanceof Error ? error.message : "Could not carry forward.");
  }
  revalidatePath("/practice/workpapers");
  redirect(wpPath(id));
}

// ------------------------------------------------------------------- requests

export async function createRequestAction(clientId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  const path = `/practice/clients/${clientId}`;
  await run(path, async () => {
    await PracticeRequestService.create(actor, practice.id, clientId, {
      type: str(formData, "type") as RequestType,
      subject: str(formData, "subject"),
      body: str(formData, "body"),
      dueDate: str(formData, "dueDate") || null,
    });
    return "Request sent. It appears in the client's own Requests inbox in the app (there is no email notification).";
  });
}

export async function replyRequestAction(clientId: string, requestId: string, formData: FormData): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  const path = `/practice/clients/${clientId}`;
  await run(path, async () => {
    const file = formData.get("file");
    await PracticeRequestService.reply(actor, practice.id, clientId, requestId, {
      body: str(formData, "body"),
      attachment: file instanceof File && file.size > 0 ? { fileName: file.name, mimeType: file.type || "application/octet-stream", data: Buffer.from(await file.arrayBuffer()) } : undefined,
    });
  });
}

export async function closeRequestAction(clientId: string, requestId: string): Promise<void> {
  const { actor, practice } = await requireCurrentPractice();
  await run(`/practice/clients/${clientId}`, async () => {
    await PracticeRequestService.close(actor, practice.id, clientId, requestId);
  });
}
