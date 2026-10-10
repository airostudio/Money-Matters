import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeTestPools, pgMessage, resetDatabase } from "../../helpers/db";
import { addLinkedClient, createPracticeWorld, revokeConsent, type PracticeWorld } from "../../helpers/practice";
import { withUserScope } from "@/db/user-scope";
import { practiceAuditLogs, practiceClientGroupMembers, practiceTasks } from "@/db/schema";
import { TaskService } from "@/domain/practice/task-service";
import { DeadlineService } from "@/domain/practice/deadline-service";
import { BulkService } from "@/domain/practice/bulk-service";
import { ClientGroupService } from "@/domain/practice/client-group-service";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { HealthService } from "@/domain/practice/health-service";
import { PracticeService } from "@/domain/practice/practice-service";
import { BulkSelectionError, ClientLinkNotFoundError, InvalidAssigneeError, PracticePermissionError, PracticeValidationError } from "@/domain/practice/errors";
import { InvalidDeadlineRuleError } from "@/domain/practice/tax-calendar";

describe("Tasks, deadlines, tax calendar, client groups and bulk actions", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let w: PracticeWorld;
  const A = () => w.clients.A.organizationId;

  beforeEach(async () => {
    await resetDatabase();
    w = await createPracticeWorld();
  });

  describe("tasks", () => {
    it("anyone in the practice creates a task for a linked client; it is practice-internal (an outsider cannot read or write any)", async () => {
      const task = await TaskService.create(w.s1Actor, w.practiceId, { title: "Chase receipts", clientOrganizationId: A(), dueDate: "2026-10-20", category: "BOOKKEEPING", priority: "HIGH" });
      expect(task).toMatchObject({ title: "Chase receipts", status: "OPEN", clientName: w.clients.A.name, category: "BOOKKEEPING", priority: "HIGH", dueDate: "2026-10-20" });

      expect(await withUserScope(w.outsider.id, (tx) => tx.select().from(practiceTasks))).toEqual([]);
      expect(await pgMessage(withUserScope(w.outsider.id, (tx) => tx.insert(practiceTasks).values({ practiceId: w.practiceId, title: "x", createdByUserId: w.outsider.id })))).toMatch(/row-level security/i);
      await expect(TaskService.list(w.outsiderActor, w.practiceId)).rejects.toThrow(/does not exist/);
    });

    it("validates its inputs: a title, ISO dates, a linked client, an active assignee", async () => {
      await expect(TaskService.create(w.s1Actor, w.practiceId, { title: "  " })).rejects.toBeInstanceOf(PracticeValidationError);
      await expect(TaskService.create(w.s1Actor, w.practiceId, { title: "x", dueDate: "05/10/2026" })).rejects.toBeInstanceOf(PracticeValidationError);
      await expect(TaskService.create(w.s1Actor, w.practiceId, { title: "x", clientOrganizationId: w.clients.A.owner.organizationId.replace(/.$/, "0") })).rejects.toBeInstanceOf(ClientLinkNotFoundError);
      await expect(TaskService.create(w.s1Actor, w.practiceId, { title: "x", assignedUserId: w.outsider.id })).rejects.toBeInstanceOf(InvalidAssigneeError);
    });

    it("STAFF can change a task they created or are assigned, but not someone else's, and cannot assign work to others; MANAGER+ can", async () => {
      const mine = await TaskService.create(w.s1Actor, w.practiceId, { title: "Mine" });
      const theirs = await TaskService.create(w.s2Actor, w.practiceId, { title: "Theirs" });
      await TaskService.update(w.s1Actor, w.practiceId, mine.id, { title: "Mine, renamed" });
      await expect(TaskService.update(w.s1Actor, w.practiceId, theirs.id, { title: "Hijack" })).rejects.toBeInstanceOf(PracticePermissionError);
      await expect(TaskService.update(w.s1Actor, w.practiceId, mine.id, { assignedUserId: w.s2.id })).rejects.toBeInstanceOf(PracticePermissionError);
      await TaskService.update(w.s1Actor, w.practiceId, mine.id, { assignedUserId: w.s1.id }); // assigning to self is fine
      const reassigned = await TaskService.update(w.partnerActor, w.practiceId, theirs.id, { assignedUserId: w.s1.id });
      expect(reassigned.assignedName).toBe("StaffOne");
    });

    it("completing a task records who and when; reopening clears it; every change is audited", async () => {
      const t = await TaskService.create(w.partnerActor, w.practiceId, { title: "Review", assignedUserId: w.s1.id });
      const done = await TaskService.complete(w.s1Actor, w.practiceId, t.id);
      expect(done.status).toBe("DONE");
      expect(done.completedAt).not.toBeNull();
      const reopened = await TaskService.update(w.s1Actor, w.practiceId, t.id, { status: "OPEN" });
      expect(reopened.completedAt).toBeNull();
      const actions = (await withUserScope(w.partner.id, (tx) => tx.select({ a: practiceAuditLogs.action }).from(practiceAuditLogs).where(eq(practiceAuditLogs.entityId, t.id)))).map((r) => r.a).sort();
      expect(actions).toEqual(["practice_task.created", "practice_task.done", "practice_task.open"].sort());
    });

    it("lists open tasks by due date (undated last), with filters; removed staff's open tasks are unassigned", async () => {
      await TaskService.create(w.partnerActor, w.practiceId, { title: "Later", dueDate: "2026-12-01", assignedUserId: w.s2.id });
      await TaskService.create(w.partnerActor, w.practiceId, { title: "Soon", dueDate: "2026-10-10", clientOrganizationId: A(), assignedUserId: w.s2.id });
      await TaskService.create(w.partnerActor, w.practiceId, { title: "Undated" });
      const finished = await TaskService.create(w.partnerActor, w.practiceId, { title: "Finished", dueDate: "2026-09-01" });
      await TaskService.complete(w.partnerActor, w.practiceId, finished.id);

      expect((await TaskService.list(w.s1Actor, w.practiceId)).map((t) => t.title)).toEqual(["Soon", "Later", "Undated"]);
      expect((await TaskService.list(w.s1Actor, w.practiceId, { status: "all" })).length).toBe(4);
      expect((await TaskService.list(w.s1Actor, w.practiceId, { clientOrganizationId: A() })).map((t) => t.title)).toEqual(["Soon"]);
      expect((await TaskService.list(w.s1Actor, w.practiceId, { dueFrom: "2026-11-01" })).map((t) => t.title)).toEqual(["Later"]);

      await PracticeService.removeStaff(w.partnerActor, w.practiceId, w.s2.id);
      expect((await TaskService.list(w.s1Actor, w.practiceId)).every((t) => t.assignedUserId === null)).toBe(true);
    });

    it("tasks are the practice's own record: they survive the client revoking access", async () => {
      await TaskService.create(w.partnerActor, w.practiceId, { title: "File year-end", clientOrganizationId: A() });
      await revokeConsent(w.clients.A, w.practiceId);
      await ClientLinkService.verify(w.partnerActor, w.practiceId, [A()]);
      const tasks = await TaskService.list(w.partnerActor, w.practiceId, { clientOrganizationId: A() });
      expect(tasks.map((t) => t.title)).toEqual(["File year-end"]);
    });
  });

  describe("recurring deadlines (the tax calendar)", () => {
    const quarterly = { name: "Quarterly lodgement", frequency: "QUARTERLY" as const, periodEndMonth: 6, dueMonthsAfter: 1, dueDay: 28, category: "BAS" as const };

    it("generates the next occurrences as tasks from a rule the practice wrote, assigns the client's responsible staff member, and is idempotent", async () => {
      await ClientLinkService.assign(w.partnerActor, w.practiceId, A(), w.s1.id);
      const tpl = await DeadlineService.createTemplate(w.partnerActor, w.practiceId, { ...quarterly, clientOrganizationId: A() });

      const first = await DeadlineService.generate(w.partnerActor, w.practiceId, { today: "2026-10-05", occurrences: 3 });
      expect(first).toEqual({ created: 3, templates: 1 });
      const tasks = await TaskService.list(w.partnerActor, w.practiceId, { clientOrganizationId: A() });
      expect(tasks.map((t) => [t.dueDate, t.category, t.assignedName, t.fromTemplate])).toEqual([
        ["2026-10-28", "BAS", "StaffOne", true],
        ["2027-01-28", "BAS", "StaffOne", true],
        ["2027-04-28", "BAS", "StaffOne", true],
      ]);
      expect(tasks[0]!.title).toBe("Quarterly lodgement — period ending 2026-09-30");

      // Running it again creates nothing; moving the date forward adds only the new occurrence.
      expect((await DeadlineService.generate(w.partnerActor, w.practiceId, { today: "2026-10-05", occurrences: 3 })).created).toBe(0);
      expect((await DeadlineService.generate(w.partnerActor, w.practiceId, { today: "2026-10-29", occurrences: 3 })).created).toBe(1);
      expect(tpl.clientOrganizationId).toBe(A());
    });

    it("an inactive template generates nothing; editing the rule changes later generations", async () => {
      const tpl = await DeadlineService.createTemplate(w.partnerActor, w.practiceId, quarterly);
      await DeadlineService.updateTemplate(w.partnerActor, w.practiceId, tpl.id, { isActive: false });
      expect((await DeadlineService.generate(w.partnerActor, w.practiceId, { today: "2026-10-05" })).created).toBe(0);
      await DeadlineService.updateTemplate(w.partnerActor, w.practiceId, tpl.id, { isActive: true, dueDay: 31, dueMonthsAfter: 2 });
      await DeadlineService.generate(w.partnerActor, w.practiceId, { today: "2026-10-05", occurrences: 1 });
      expect((await TaskService.list(w.partnerActor, w.practiceId))[0]!.dueDate).toBe("2026-11-30"); // 31 clamped to the 30-day month
    });

    it("needs MANAGER+, validates the rule, and refuses a template for an unlinked client", async () => {
      await expect(DeadlineService.createTemplate(w.s1Actor, w.practiceId, quarterly)).rejects.toBeInstanceOf(PracticePermissionError);
      await expect(DeadlineService.createTemplate(w.partnerActor, w.practiceId, { ...quarterly, dueDay: 40 })).rejects.toBeInstanceOf(InvalidDeadlineRuleError);
      await expect(
        DeadlineService.createTemplate(w.partnerActor, w.practiceId, { ...quarterly, clientOrganizationId: "00000000-0000-0000-0000-000000000000" }),
      ).rejects.toBeInstanceOf(ClientLinkNotFoundError);
      await expect(DeadlineService.generate(w.s1Actor, w.practiceId, {})).rejects.toBeInstanceOf(PracticePermissionError);
    });
  });

  describe("client groups and bulk actions (bounded, sequential)", () => {
    it("creates groups, applies one to several clients, and a group name is unique per practice", async () => {
      const g = await ClientGroupService.create(w.partnerActor, w.practiceId, "Monthly BAS");
      await expect(ClientGroupService.create(w.partnerActor, w.practiceId, "Monthly BAS")).rejects.toBeInstanceOf(PracticeValidationError);
      await expect(ClientGroupService.create(w.s1Actor, w.practiceId, "Nope")).rejects.toBeInstanceOf(PracticePermissionError);
      const second = await addLinkedClient(w, "client-g2");
      expect(await BulkService.applyGroup(w.partnerActor, w.practiceId, g.id, [A(), second.organizationId])).toBe(2);
      expect(await BulkService.applyGroup(w.partnerActor, w.practiceId, g.id, [A()])).toBe(1); // idempotent
      expect((await ClientGroupService.list(w.s1Actor, w.practiceId))[0]).toMatchObject({ name: "Monthly BAS", clientCount: 2 });
      const rows = await withUserScope(w.partner.id, (tx) => tx.select().from(practiceClientGroupMembers).where(eq(practiceClientGroupMembers.groupId, g.id)));
      expect(rows.length).toBe(2);
      const links = await ClientLinkService.list(w.partnerActor, w.practiceId);
      expect(links.find((l) => l.clientOrganizationId === A())!.groups.map((x) => x.name)).toEqual(["Monthly BAS"]);
    });

    it("the dashboard can be filtered by group and by assignee", async () => {
      const second = await addLinkedClient(w, "client-g3");
      const g = await ClientGroupService.create(w.partnerActor, w.practiceId, "Hospitality");
      await BulkService.applyGroup(w.partnerActor, w.practiceId, g.id, [second.organizationId]);
      await BulkService.assign(w.partnerActor, w.practiceId, [A()], w.s2.id);
      const byGroup = await HealthService.dashboard(w.s1Actor, w.practiceId, { groupId: g.id });
      expect(byGroup.rows.map((r) => r.clientOrganizationId)).toEqual([second.organizationId]);
      const byAssignee = await HealthService.dashboard(w.s1Actor, w.practiceId, { assignedTo: w.s2.id });
      expect(byAssignee.rows.map((r) => r.clientOrganizationId)).toEqual([A()]);
    });

    it("bulk-assigns staff, leaving a note in each ACTIVE client's own audit log only", async () => {
      const second = await addLinkedClient(w, "client-g4");
      expect(await BulkService.assign(w.partnerActor, w.practiceId, [A(), second.organizationId], w.s1.id)).toBe(2);
      const links = await ClientLinkService.list(w.partnerActor, w.practiceId);
      expect(links.filter((l) => l.assignedUserId === w.s1.id).length).toBe(2);
      await expect(BulkService.assign(w.s1Actor, w.practiceId, [A()], w.s1.id)).rejects.toBeInstanceOf(PracticePermissionError);
      await expect(BulkService.assign(w.partnerActor, w.practiceId, [A()], w.outsider.id)).rejects.toBeInstanceOf(InvalidAssigneeError);
    });

    it("bulk-creates one task per selected client in one transaction, audited once", async () => {
      const second = await addLinkedClient(w, "client-g5");
      const n = await BulkService.createTask(w.partnerActor, w.practiceId, [A(), second.organizationId], { title: "Send engagement letter", dueDate: "2026-11-15", category: "REVIEW" });
      expect(n).toBe(2);
      const tasks = await TaskService.list(w.partnerActor, w.practiceId);
      expect(tasks.map((t) => t.clientOrganizationId).sort()).toEqual([A(), second.organizationId].sort());
      const audit = await withUserScope(w.partner.id, (tx) => tx.select().from(practiceAuditLogs).where(and(eq(practiceAuditLogs.action, "practice_task.bulk_created"))));
      expect(audit.length).toBe(1);
      // An unlinked client in the selection rolls the whole thing back.
      await expect(
        BulkService.createTask(w.partnerActor, w.practiceId, [A(), "00000000-0000-0000-0000-000000000000"], { title: "Atomic" }),
      ).rejects.toBeInstanceOf(ClientLinkNotFoundError);
      expect((await TaskService.list(w.partnerActor, w.practiceId)).some((t) => t.title === "Atomic")).toBe(false);
    });

    it("every bulk action is bounded to one page of clients", async () => {
      const eleven = Array.from({ length: 11 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
      const g = await ClientGroupService.create(w.partnerActor, w.practiceId, "G");
      await expect(BulkService.assign(w.partnerActor, w.practiceId, eleven, w.s1.id)).rejects.toBeInstanceOf(BulkSelectionError);
      await expect(BulkService.applyGroup(w.partnerActor, w.practiceId, g.id, eleven)).rejects.toBeInstanceOf(BulkSelectionError);
      await expect(BulkService.createTask(w.partnerActor, w.practiceId, eleven, { title: "x" })).rejects.toBeInstanceOf(BulkSelectionError);
      await expect(BulkService.refresh(w.partnerActor, w.practiceId, eleven)).rejects.toBeInstanceOf(BulkSelectionError);
      await expect(BulkService.assign(w.partnerActor, w.practiceId, [], null)).rejects.toBeInstanceOf(BulkSelectionError);
    });
  });
});
