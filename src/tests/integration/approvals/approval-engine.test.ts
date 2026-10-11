import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { addTestMember, adminDb, closeTestPools, createTestOrg, pgMessage, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { createExpenseFixtures } from "../../helpers/expenses";
import {
  approvalDecisions,
  approvalRequests,
  approvalSteps,
  auditLogs,
  bills,
  expenseClaims,
  notifications,
  organizationMemberships,
  organizations,
  paymentRuns,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { ApprovalService } from "@/domain/approvals/approval-service";
import { ApprovalWorkflow } from "@/domain/approvals/approval-workflow";
import {
  ApprovalNotEligibleError,
  ApprovalNotPendingError,
  ApprovalPendingError,
  ApprovalRequestNotFoundError,
  ApprovalRequiredError,
  InvalidApprovalPolicyError,
  NoApprovalPolicyMatchesError,
} from "@/domain/approvals/errors";
import type { PolicyInput } from "@/domain/approvals/policy";
import { OrganizationArchivedError } from "@/domain/organizations/archive-rules";
import { BillService } from "@/domain/purchases/bill-service";
import { PaymentRunService } from "@/domain/purchases/payment-run-service";
import { ExpenseClaimService } from "@/domain/expenses/expense-claim-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";

const db = () => adminDb();

describe("Approval engine", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;
  let expenses: Awaited<ReturnType<typeof createExpenseFixtures>>;
  let creator: Actor; // ACCOUNTS_PAYABLE: can create and post bills, create payment runs
  let acc1: Actor;
  let acc2: Actor;
  let manager: Actor;
  let employee: Actor;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("approvals");
    owner = org.owner;
    orgId = org.organizationId;
    purchases = await createPurchasesFixtures(owner, org.baseCurrency);
    expenses = await createExpenseFixtures(owner, org.baseCurrency);
    creator = await addTestMember(owner, "ACCOUNTS_PAYABLE", "Creator");
    acc1 = await addTestMember(owner, "ACCOUNTANT", "Accountant One");
    acc2 = await addTestMember(owner, "ACCOUNTANT", "Accountant Two");
    manager = await addTestMember(owner, "MANAGER", "Manager");
    employee = await addTestMember(owner, "EMPLOYEE", "Employee");
  });

  const billPolicy = (over: Partial<PolicyInput> = {}): PolicyInput => ({
    name: "Bills over 1000",
    documentType: "SUPPLIER_BILL",
    minAmount: "1000.00",
    steps: [{ name: "Finance", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 }],
    ...over,
  });

  async function draftBill(actor: Actor, unitPrice: string) {
    return BillService.create(actor, {
      supplierContactId: purchases.supplierContactId,
      issueDate: new Date("2026-01-01"),
      dueDate: new Date("2026-01-31"),
      currency: "AUD",
      apAccountId: purchases.apAccountId,
      lines: [{ description: "Materials", quantity: "1", unitPrice, accountId: purchases.expenseAccountId }],
    });
  }

  async function requestsFor(documentId: string) {
    return db().select().from(approvalRequests).where(eq(approvalRequests.documentId, documentId)).orderBy(desc(approvalRequests.requestedAt));
  }

  async function auditActions(entityId: string) {
    const rows = await db().select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
    return rows.map((r) => r.action);
  }

  // ---------------------------------------------------------------------------------------------------------------
  describe("backwards compatibility: no policy means nothing changes", () => {
    it("a bill, claim and payment run follow their existing single-step flow when no policy exists", async () => {
      const bill = await draftBill(creator, "99999.00");
      const posted = await BillService.approveAndPost(acc1, bill.id);
      expect(posted.status).toBe("APPROVED");
      expect(await db().select().from(approvalRequests)).toHaveLength(0);

      const claim = await ExpenseClaimService.create(employee, {
        employeeUserId: employee.userId,
        claimDate: new Date("2026-02-01"),
        description: "Trip",
        currency: "AUD",
        payableAccountId: expenses.payableAccountId,
        lines: [{ description: "Flight", amount: "5000.00", expenseAccountId: expenses.expenseAccountId }],
      });
      await ExpenseClaimService.submit(employee, claim.id);
      expect((await ExpenseClaimService.approve(acc1, claim.id))!.status).toBe("APPROVED");

      const run = await PaymentRunService.create(creator, { paymentDate: new Date("2026-02-01"), currency: "AUD", paymentAccountId: purchases.bankGlAccountId, billIds: [bill.id] });
      await PaymentRunService.submitForApproval(creator, run!.id);
      expect((await PaymentRunService.approve(acc1, run!.id))!.status).toBe("PAID");
      expect(await db().select().from(approvalRequests)).toHaveLength(0);
    });

    it("a policy that does not match this document leaves it alone (and requesting approval says so)", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const small = await draftBill(creator, "999.99");
      await expect(ApprovalService.requestApproval(creator, "SUPPLIER_BILL", small.id)).rejects.toThrow(NoApprovalPolicyMatchesError);
      expect((await BillService.approveAndPost(acc1, small.id)).status).toBe("APPROVED");
    });

    it("an inactive policy is ignored", async () => {
      const policy = await ApprovalService.createPolicy(owner, billPolicy());
      await ApprovalService.setPolicyActive(owner, policy.id, false);
      const big = await draftBill(creator, "5000.00");
      expect((await BillService.approveAndPost(acc1, big.id)).status).toBe("APPROVED");
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("supplier bills: multi-step flow enforced in the domain service", () => {
    it("blocks posting until every step is approved, then posts through the bill's own service", async () => {
      await ApprovalService.createPolicy(owner, billPolicy({ steps: [
        { name: "Finance", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 },
        { name: "Director", roles: ["OWNER"], userIds: [], requiredApprovals: 1 },
      ] }));
      const bill = await draftBill(creator, "1500.00");

      // Covered by a policy but no request yet.
      await expect(BillService.approveAndPost(creator, bill.id)).rejects.toThrow(ApprovalRequiredError);
      await expect(BillService.approveAndPost(owner, bill.id)).rejects.toThrow(ApprovalRequiredError);

      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      expect(request.status).toBe("PENDING");
      // Idempotent: asking again returns the same open request.
      expect((await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id)).id).toBe(request.id);
      await expect(BillService.approveAndPost(owner, bill.id)).rejects.toThrow(ApprovalPendingError);

      // Step 2 is not open to the owner yet: only the CURRENT step can be decided, by its assignee.
      await expect(ApprovalWorkflow.decide(owner, request.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalNotEligibleError);

      const first = await ApprovalWorkflow.decide(acc1, request.id, { decision: "APPROVE", comment: "Looks fine" });
      expect(first.outcome).toBe("STEP_APPROVED");
      expect(first.documentUpdated).toBe(false);
      expect((await db().select().from(bills).where(eq(bills.id, bill.id)))[0]!.status).toBe("DRAFT");
      await expect(BillService.approveAndPost(owner, bill.id)).rejects.toThrow(ApprovalPendingError);

      // acc2 holds the ACCOUNTANT role, but step 2 wants an OWNER.
      await expect(ApprovalWorkflow.decide(acc2, request.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalNotEligibleError);

      const second = await ApprovalWorkflow.decide(owner, request.id, { decision: "APPROVE" });
      expect(second.outcome).toBe("APPROVED");
      expect(second.documentUpdated).toBe(true);
      expect(second.documentError).toBeNull();
      expect((await db().select().from(bills).where(eq(bills.id, bill.id)))[0]!.status).toBe("APPROVED");

      const [row] = await requestsFor(bill.id);
      expect(row!.status).toBe("APPROVED");
      const steps = await db().select().from(approvalSteps).where(eq(approvalSteps.requestId, request.id));
      expect(steps.map((s) => s.status).sort()).toEqual(["APPROVED", "APPROVED"]);
      const decisions = await db().select().from(approvalDecisions).where(eq(approvalDecisions.requestId, request.id));
      expect(decisions.map((d) => d.decision)).toEqual(["APPROVE", "APPROVE"]);
      expect(await auditActions(request.id)).toEqual(expect.arrayContaining(["approval.requested", "approval.step_approved", "approval.approved"]));
    });

    it("several approvals on one step: needs N different people", async () => {
      await ApprovalService.createPolicy(owner, billPolicy({ steps: [{ name: "Two accountants", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 2 }] }));
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      expect((await ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).outcome).toBe("PENDING_MORE");
      await expect(ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalNotEligibleError);
      const done = await ApprovalWorkflow.decide(acc2, request.id, { decision: "APPROVE" });
      expect(done.outcome).toBe("APPROVED");
      expect(done.documentUpdated).toBe(true);
    });

    it("an approval clears only the document that was approved: editing the amount afterwards needs a fresh approval", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      expect((await ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).outcome).toBe("APPROVED"); // engine only, document untouched
      await BillService.update(creator, bill.id, {
        supplierContactId: purchases.supplierContactId,
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-31"),
        currency: "AUD",
        apAccountId: purchases.apAccountId,
        lines: [{ description: "Materials", quantity: "1", unitPrice: "9000.00", accountId: purchases.expenseAccountId }],
      });
      await expect(BillService.approveAndPost(creator, bill.id)).rejects.toThrow(ApprovalRequiredError);
    });

    it("editing a bill while its request is pending cancels that request; resubmitting starts a new one and the old one is kept", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const first = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await BillService.update(creator, bill.id, {
        supplierContactId: purchases.supplierContactId,
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-31"),
        currency: "AUD",
        apAccountId: purchases.apAccountId,
        lines: [{ description: "Materials", quantity: "1", unitPrice: "2100.00", accountId: purchases.expenseAccountId }],
      });
      const second = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      expect(second.id).not.toBe(first.id);
      const rows = await requestsFor(bill.id);
      expect(rows.map((r) => r.status).sort()).toEqual(["CANCELLED", "PENDING"]);
      expect(rows.find((r) => r.id === first.id)!.amount).toBe("2000.0000");
      expect(rows.find((r) => r.id === second.id)!.amount).toBe("2100.0000");
    });

    it("rejection needs a reason, returns the bill to draft-with-reason, blocks posting, and a resubmission is a new request", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "3000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.decide(acc1, request.id, { decision: "REJECT" })).rejects.toThrow(ApprovalNotEligibleError);
      const rejected = await ApprovalWorkflow.decide(acc1, request.id, { decision: "REJECT", comment: "Wrong cost centre" });
      expect(rejected.outcome).toBe("REJECTED");
      const [row] = await requestsFor(bill.id);
      expect(row!.status).toBe("REJECTED");
      expect(row!.decisionReason).toBe("Wrong cost centre");
      expect((await db().select().from(bills).where(eq(bills.id, bill.id)))[0]!.status).toBe("DRAFT");
      await expect(BillService.approveAndPost(owner, bill.id)).rejects.toThrow(ApprovalRequiredError);
      await expect(ApprovalService.decide(acc2, request.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalNotPendingError);

      const again = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      expect(again.id).not.toBe(request.id);
      expect(await requestsFor(bill.id)).toHaveLength(2);
      await ApprovalWorkflow.decide(acc2, again.id, { decision: "APPROVE" });
      expect((await db().select().from(bills).where(eq(bills.id, bill.id)))[0]!.status).toBe("APPROVED");
    });

    it("the policy also filters by supplier, so only that supplier's bills route through approval", async () => {
      await ApprovalService.createPolicy(owner, billPolicy({ name: "Other supplier", minAmount: null, filters: { supplierContactIds: ["99999999-9999-4999-8999-999999999999"] } }));
      const bill = await draftBill(creator, "50000.00");
      expect((await BillService.approveAndPost(acc1, bill.id)).status).toBe("APPROVED");
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("segregation of duties and decision-time checks", () => {
    it("the requester and the document creator can never approve, even holding the role and the native permission", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      // An ACCOUNTANT both creates the bill and asks for approval.
      const bill = await draftBill(acc1, "2000.00");
      const request = await ApprovalService.requestApproval(acc1, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).rejects.toThrow(/raised or created/);
      await ApprovalService.override(owner, request.id, { outcome: "REJECT", reason: "Start over" });
      // A different accountant now requests it: the requester AND the creator are both excluded.
      const byAcc2 = await ApprovalService.requestApproval(acc2, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.decide(acc1, byAcc2.id, { decision: "APPROVE" })).rejects.toThrow(/raised or created/);
      await expect(ApprovalService.decide(acc2, byAcc2.id, { decision: "APPROVE" })).rejects.toThrow(/raised or created/);
      const acc3 = await addTestMember(owner, "ACCOUNTANT", "Accountant Three");
      expect((await ApprovalService.decide(acc3, byAcc2.id, { decision: "APPROVE" })).outcome).toBe("APPROVED");
    });

    it("one person cannot satisfy two steps unless the policy explicitly allows it, and then it is audited", async () => {
      const steps = [
        { name: "Step one", roles: ["ACCOUNTANT" as const], userIds: [], requiredApprovals: 1 },
        { name: "Step two", roles: ["ACCOUNTANT" as const], userIds: [], requiredApprovals: 1 },
      ];
      const strict = await ApprovalService.createPolicy(owner, billPolicy({ name: "Strict", steps }));
      const bill = await draftBill(creator, "2000.00");
      const r1 = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await ApprovalService.decide(acc1, r1.id, { decision: "APPROVE" });
      await expect(ApprovalService.decide(acc1, r1.id, { decision: "APPROVE" })).rejects.toThrow(/different person/);
      expect((await ApprovalService.decide(acc2, r1.id, { decision: "APPROVE" })).outcome).toBe("APPROVED");

      await ApprovalService.setPolicyActive(owner, strict.id, false);
      await ApprovalService.createPolicy(owner, billPolicy({ name: "Lenient", steps, allowSamePersonMultipleSteps: true }));
      const bill2 = await draftBill(creator, "2000.00");
      const r2 = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill2.id);
      const a = await ApprovalService.decide(acc1, r2.id, { decision: "APPROVE" });
      expect(a.repeatApprover).toBe(false);
      const b = await ApprovalService.decide(acc1, r2.id, { decision: "APPROVE" });
      expect(b.outcome).toBe("APPROVED");
      expect(b.repeatApprover).toBe(true);
      const decisions = await db().select().from(approvalDecisions).where(eq(approvalDecisions.requestId, r2.id));
      expect(decisions.filter((d) => d.repeatApprover)).toHaveLength(1);
      const audit = await db().select().from(auditLogs).where(and(eq(auditLogs.entityId, r2.id), eq(auditLogs.action, "approval.approved")));
      expect((audit[0]!.after as { repeatApprover: boolean }).repeatApprover).toBe(true);
    });

    it("a role change between steps is honoured at decision time", async () => {
      await ApprovalService.createPolicy(owner, billPolicy({ steps: [
        { name: "Finance", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 },
        { name: "Second look", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 },
      ] }));
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await ApprovalService.decide(acc1, request.id, { decision: "APPROVE" });
      // acc2 is demoted AFTER the request was created, before deciding step two.
      await db().update(organizationMemberships).set({ role: "EMPLOYEE" }).where(and(eq(organizationMemberships.userId, acc2.userId), eq(organizationMemberships.organizationId, orgId)));
      await expect(ApprovalService.decide(acc2, request.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalNotEligibleError);
      // The actor object still SAYS ACCOUNTANT (a stale session); the database role is what counts.
      expect(acc2.role).toBe("ACCOUNTANT");
      // A deactivated member is refused too.
      await db().update(organizationMemberships).set({ role: "ACCOUNTANT", isActive: false }).where(and(eq(organizationMemberships.userId, acc2.userId), eq(organizationMemberships.organizationId, orgId)));
      await expect(ApprovalService.decide(acc2, request.id, { decision: "APPROVE" })).rejects.toThrow(/not an active member/);
      // A newly promoted ACCOUNTANT who was never named can decide, because the role is evaluated now.
      const late = await addTestMember(owner, "EMPLOYEE", "Late");
      await db().update(organizationMemberships).set({ role: "ACCOUNTANT" }).where(and(eq(organizationMemberships.userId, late.userId), eq(organizationMemberships.organizationId, orgId)));
      expect((await ApprovalService.decide({ ...late, role: "EMPLOYEE" }, request.id, { decision: "APPROVE" })).outcome).toBe("APPROVED");
    });

    it("a specific named person can satisfy a step, but only while their role can still approve that document type", async () => {
      await ApprovalService.createPolicy(owner, billPolicy({ steps: [{ name: "Named", roles: [], userIds: [acc1.userId], requiredApprovals: 1 }] }));
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.decide(acc2, request.id, { decision: "APPROVE" })).rejects.toThrow(/not assigned/);
      await db().update(organizationMemberships).set({ role: "READ_ONLY" }).where(and(eq(organizationMemberships.userId, acc1.userId), eq(organizationMemberships.organizationId, orgId)));
      await expect(ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalNotEligibleError);
    });

    it("a stale APPROVE cannot be replayed on a decided request, and two decisions cannot both win", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await ApprovalService.decide(acc1, request.id, { decision: "APPROVE" });
      await expect(ApprovalService.decide(acc2, request.id, { decision: "REJECT", comment: "late" })).rejects.toThrow(ApprovalNotPendingError);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("override and reassignment (no scheduler: waiting-since + manual escalation)", () => {
    it("an owner/administrator can override with a reason; remaining steps are SKIPPED and everything is audited", async () => {
      await ApprovalService.createPolicy(owner, billPolicy({ steps: [
        { name: "Finance", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 },
        { name: "Director", roles: ["OWNER"], userIds: [], requiredApprovals: 1 },
      ] }));
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.override(acc1, request.id, { outcome: "APPROVE", reason: "I am in a hurry" })).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalService.override(owner, request.id, { outcome: "APPROVE", reason: "no" })).rejects.toThrow(/reason/);
      const result = await ApprovalWorkflow.override(owner, request.id, { outcome: "APPROVE", reason: "Approver on leave, supplier chasing" });
      expect(result.outcome).toBe("APPROVED");
      expect(result.documentUpdated).toBe(true);
      const [row] = await requestsFor(bill.id);
      expect(row!.overriddenById).toBe(owner.userId);
      expect(row!.overrideReason).toBe("Approver on leave, supplier chasing");
      const steps = await db().select().from(approvalSteps).where(eq(approvalSteps.requestId, request.id));
      expect(steps.map((s) => s.status)).toEqual(["SKIPPED", "SKIPPED"]);
      const audit = await db().select().from(auditLogs).where(and(eq(auditLogs.entityId, request.id), eq(auditLogs.action, "approval.override_approved")));
      expect(audit).toHaveLength(1);
      expect((audit[0]!.before as { status: string }).status).toBe("PENDING");
      expect((audit[0]!.after as { reason: string }).reason).toContain("on leave");
    });

    it("the person who raised the document cannot override its approval, even as OWNER", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(owner, "2000.00");
      const request = await ApprovalService.requestApproval(owner, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.override(owner, request.id, { outcome: "APPROVE", reason: "approving my own bill" })).rejects.toThrow(/raised or created/);
      await expect(ApprovalService.decide(owner, request.id, { decision: "APPROVE" })).rejects.toThrow(/raised or created/);
      const admin = await addTestMember(owner, "ADMINISTRATOR", "Admin");
      expect((await ApprovalService.override(admin, request.id, { outcome: "APPROVE", reason: "Second owner agreed offline" })).outcome).toBe("APPROVED");
    });

    it("reassigning the waiting step to a named person works, is audited, notifies them, and keeps the requester out", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.reassign(acc1, request.id, { userIds: [acc2.userId], reason: "not allowed" })).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalService.reassign(owner, request.id, { userIds: [creator.userId], reason: "wrongly picked" })).rejects.toThrow(/raised or created/);
      await expect(ApprovalService.reassign(owner, request.id, { userIds: [employee.userId], reason: "an employee" })).rejects.toThrow(/cannot currently approve/);
      await ApprovalService.reassign(owner, request.id, { userIds: [acc2.userId], reason: "acc1 is away this week" });
      // acc1 still holds the ACCOUNTANT role but the step now names only acc2.
      await expect(ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).rejects.toThrow(/not assigned/);
      expect((await ApprovalService.decide(acc2, request.id, { decision: "APPROVE" })).outcome).toBe("APPROVED");
      expect(await auditActions(request.id)).toContain("approval.reassigned");
      const mine = await db().select().from(notifications).where(eq(notifications.recipientUserId, acc2.userId));
      expect(mine.some((n) => n.title.startsWith("Approval needed"))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("non-human actors can never decide (an OWNER role behind them changes nothing)", () => {
    it.each(["API", "AI", "AUTOMATION", "SYSTEM"] as const)("%s actor with OWNER role is refused everywhere", async (type) => {
      const robot: Actor = { userId: owner.userId, organizationId: orgId, role: "OWNER", type };
      await expect(ApprovalService.createPolicy(robot, billPolicy())).rejects.toThrow(PermissionDeniedError);
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await expect(ApprovalService.decide(robot, request.id, { decision: "APPROVE" })).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalService.decide(robot, request.id, { decision: "REJECT", comment: "no" })).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalWorkflow.decide(robot, request.id, { decision: "APPROVE" })).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalService.override(robot, request.id, { outcome: "APPROVE", reason: "robot override" })).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalService.reassign(robot, request.id, { userIds: [acc1.userId], reason: "robot reassign" })).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalService.setPolicyActive(robot, "00000000-0000-4000-8000-000000000000", false)).rejects.toThrow(PermissionDeniedError);
      await expect(ApprovalService.inbox(robot)).rejects.toThrow(PermissionDeniedError);
      expect((await requestsFor(bill.id))[0]!.status).toBe("PENDING");
      expect((await db().select().from(approvalDecisions)).length).toBe(0);
    });

    it("an API actor carrying OWNER cannot post a policy-governed bill directly either (the gate is in the bill service)", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const robot: Actor = { userId: owner.userId, organizationId: orgId, role: "OWNER", type: "API" };
      await expect(BillService.approveAndPost(robot, bill.id)).rejects.toThrow(ApprovalRequiredError);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("expense claims", () => {
    async function submittedClaim(actor: Actor, amount: string) {
      const claim = await ExpenseClaimService.create(actor, {
        employeeUserId: actor.userId,
        claimDate: new Date("2026-02-01"),
        description: "Conference",
        currency: "AUD",
        payableAccountId: expenses.payableAccountId,
        lines: [{ description: "Tickets", amount, expenseAccountId: expenses.expenseAccountId }],
      });
      await ExpenseClaimService.submit(actor, claim.id);
      return claim.id;
    }
    const claimPolicy = (): PolicyInput => ({
      name: "Claims 2000+",
      documentType: "EXPENSE_CLAIM",
      minAmount: "2000.00",
      steps: [{ name: "Manager", roles: ["MANAGER"], userIds: [], requiredApprovals: 1 }, { name: "Finance", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 }],
    });

    it("spec s.75 example: an expense over $2,000 is routed to approval by policy and cannot be approved around it", async () => {
      await ApprovalService.createPolicy(owner, claimPolicy());
      const big = await submittedClaim(employee, "2000.00"); // boundary: exactly 2000 is inside the band
      const [request] = await requestsFor(big);
      expect(request!.status).toBe("PENDING");
      expect(request!.requestedById).toBe(employee.userId);
      await expect(ExpenseClaimService.approve(manager, big)).rejects.toThrow(ApprovalPendingError);
      await expect(ExpenseClaimService.approve(owner, big)).rejects.toThrow(ApprovalPendingError);
      // The claimant can never decide their own claim, whatever their role.
      await expect(ApprovalService.decide(employee, request!.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalNotEligibleError);
      expect((await ApprovalWorkflow.decide(manager, request!.id, { decision: "APPROVE" })).outcome).toBe("STEP_APPROVED");
      const done = await ApprovalWorkflow.decide(acc1, request!.id, { decision: "APPROVE" });
      expect(done.outcome).toBe("APPROVED");
      expect(done.documentUpdated).toBe(true);
      expect((await db().select().from(expenseClaims).where(eq(expenseClaims.id, big)))[0]!.status).toBe("APPROVED");
    });

    it("a claim just under the threshold gets no request and follows the normal flow", async () => {
      await ApprovalService.createPolicy(owner, claimPolicy());
      const small = await submittedClaim(employee, "1999.99");
      expect(await requestsFor(small)).toHaveLength(0);
      expect((await ExpenseClaimService.approve(acc1, small))!.status).toBe("APPROVED");
    });

    it("rejecting in the workflow rejects the claim with the reason; rejecting the claim directly closes its request", async () => {
      await ApprovalService.createPolicy(owner, claimPolicy());
      const a = await submittedClaim(employee, "2500.00");
      const [reqA] = await requestsFor(a);
      const res = await ApprovalWorkflow.decide(manager, reqA!.id, { decision: "REJECT", comment: "Missing receipts" });
      expect(res.outcome).toBe("REJECTED");
      expect(res.documentUpdated).toBe(true);
      const claimA = (await db().select().from(expenseClaims).where(eq(expenseClaims.id, a)))[0]!;
      expect(claimA.status).toBe("REJECTED");
      expect(claimA.rejectionReason).toBe("Missing receipts");

      const b = await submittedClaim(employee, "3000.00");
      await ExpenseClaimService.reject(manager, b, "Duplicate");
      const [reqB] = await requestsFor(b);
      expect(reqB!.status).toBe("REJECTED");
      expect(reqB!.decisionReason).toBe("Duplicate");
    });

    it("notifies the first approvers when a step opens and the requester on the decision", async () => {
      await ApprovalService.createPolicy(owner, claimPolicy());
      const id = await submittedClaim(employee, "2600.00");
      const [request] = await requestsFor(id);
      const managerInbox = await db().select().from(notifications).where(eq(notifications.recipientUserId, manager.userId));
      expect(managerInbox.some((n) => n.title.includes("Approval needed") && n.sourceRefId === request!.id)).toBe(true);
      // Step 2 approvers are not told until step 1 is done.
      expect((await db().select().from(notifications).where(eq(notifications.recipientUserId, acc1.userId))).some((n) => n.sourceRefId === request!.id)).toBe(false);
      await ApprovalService.decide(manager, request!.id, { decision: "APPROVE" });
      expect((await db().select().from(notifications).where(eq(notifications.recipientUserId, acc1.userId))).some((n) => n.sourceRefId === request!.id)).toBe(true);
      await ApprovalService.decide(acc1, request!.id, { decision: "APPROVE" });
      const requesterInbox = await db().select().from(notifications).where(eq(notifications.recipientUserId, employee.userId));
      expect(requesterInbox.some((n) => n.title.startsWith("Approved:"))).toBe(true);
      // The claimant is never notified that THEY must approve.
      expect(requesterInbox.some((n) => n.title.startsWith("Approval needed"))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("payment runs (creator != approver is kept)", () => {
    async function awaitingRun() {
      const b = await BillService.approveAndPost(owner, (await draftBill(owner, "4000.00")).id);
      const run = await PaymentRunService.create(creator, { paymentDate: new Date("2026-02-01"), currency: "AUD", paymentAccountId: purchases.bankGlAccountId, billIds: [b.id] });
      await PaymentRunService.submitForApproval(creator, run!.id);
      return run!.id;
    }
    const runPolicy = (): PolicyInput => ({
      name: "Runs over 3000",
      documentType: "PAYMENT_RUN",
      minAmount: "3000.00",
      steps: [{ name: "Finance", roles: ["ACCOUNTANT", "ACCOUNTS_PAYABLE"], userIds: [], requiredApprovals: 1 }, { name: "Director", roles: ["OWNER"], userIds: [], requiredApprovals: 1 }],
    });

    it("opens a request on submit, blocks the run's own approve until done, then pays through the run service", async () => {
      await ApprovalService.createPolicy(owner, runPolicy());
      const runId = await awaitingRun();
      const [request] = await requestsFor(runId);
      expect(request!.status).toBe("PENDING");
      await expect(PaymentRunService.approve(acc1, runId)).rejects.toThrow(ApprovalPendingError);
      await expect(ApprovalService.decide(creator, request!.id, { decision: "APPROVE" })).rejects.toThrow(/raised or created/);
      await ApprovalWorkflow.decide(acc1, request!.id, { decision: "APPROVE" });
      const final = await ApprovalWorkflow.decide(owner, request!.id, { decision: "APPROVE" });
      expect(final.documentUpdated).toBe(true);
      expect((await db().select().from(paymentRuns).where(eq(paymentRuns.id, runId)))[0]!.status).toBe("PAID");
    });

    it("rejection returns the run to DRAFT; resubmitting after an edit opens a NEW request and keeps the old one", async () => {
      await ApprovalService.createPolicy(owner, runPolicy());
      const runId = await awaitingRun();
      const [first] = await requestsFor(runId);
      const res = await ApprovalWorkflow.decide(acc1, first!.id, { decision: "REJECT", comment: "Bank details look wrong" });
      expect(res.documentUpdated).toBe(true);
      expect((await db().select().from(paymentRuns).where(eq(paymentRuns.id, runId)))[0]!.status).toBe("DRAFT");
      await PaymentRunService.submitForApproval(creator, runId);
      const all = await requestsFor(runId);
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.status).sort()).toEqual(["PENDING", "REJECTED"]);
    });

    it("cancelling a run closes its open request", async () => {
      await ApprovalService.createPolicy(owner, runPolicy());
      const runId = await awaitingRun();
      await PaymentRunService.cancel(creator, runId, "Not needed");
      expect((await requestsFor(runId))[0]!.status).toBe("CANCELLED");
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("policy management", () => {
    it("needs approval:manage: owner/administrator only", async () => {
      for (const actor of [acc1, manager, creator, employee]) {
        await expect(ApprovalService.createPolicy(actor, billPolicy())).rejects.toThrow(PermissionDeniedError);
        await expect(ApprovalService.listPolicies(actor)).rejects.toThrow(PermissionDeniedError);
      }
      const admin = await addTestMember(owner, "ADMINISTRATOR", "Admin");
      expect((await ApprovalService.createPolicy(admin, billPolicy())).name).toBe("Bills over 1000");
    });

    it("rejects steps that nobody could satisfy, unknown people, bad bands; audits create/update/deactivate with before/after", async () => {
      await expect(ApprovalService.createPolicy(owner, billPolicy({ steps: [{ name: "Mgr", roles: ["MANAGER"], userIds: [], requiredApprovals: 1 }] }))).rejects.toThrow(InvalidApprovalPolicyError);
      await expect(ApprovalService.createPolicy(owner, billPolicy({ steps: [{ name: "Ghost", roles: [], userIds: ["99999999-9999-4999-8999-999999999999"], requiredApprovals: 1 }] }))).rejects.toThrow(/not an active member/);
      await expect(ApprovalService.createPolicy(owner, billPolicy({ steps: [{ name: "Emp", roles: [], userIds: [employee.userId], requiredApprovals: 1 }] }))).rejects.toThrow(/cannot currently approve/);
      await expect(ApprovalService.createPolicy(owner, billPolicy({ minAmount: "10", maxAmount: "5" }))).rejects.toThrow(InvalidApprovalPolicyError);

      const policy = await ApprovalService.createPolicy(owner, billPolicy());
      const updated = await ApprovalService.updatePolicy(owner, policy.id, billPolicy({ name: "Renamed", minAmount: "1500.00" }));
      expect(updated.minAmount).toBe("1500.0000");
      await ApprovalService.setPolicyActive(owner, policy.id, false);
      const rows = await db().select().from(auditLogs).where(eq(auditLogs.entityId, policy.id));
      expect(rows.map((r) => r.action).sort()).toEqual(["approval_policy.created", "approval_policy.deactivated", "approval_policy.updated"]);
      const upd = rows.find((r) => r.action === "approval_policy.updated")!;
      expect((upd.before as { name: string }).name).toBe("Bills over 1000");
      expect((upd.after as { name: string }).name).toBe("Renamed");
    });

    it("editing a policy never changes a request already in flight (it snapshots its policy)", async () => {
      const policy = await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await ApprovalService.updatePolicy(owner, policy.id, billPolicy({ steps: [{ name: "Owner only", roles: ["OWNER"], userIds: [], requiredApprovals: 1 }] }));
      expect((await ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).outcome).toBe("APPROVED");
    });

    it("previews how an amount routes, in plain English", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const hit = await ApprovalService.previewRouting(owner, { documentType: "SUPPLIER_BILL", amount: "1000.00", currency: "AUD" });
      expect(hit.matched?.name).toBe("Bills over 1000");
      expect(hit.text).toContain("Finance");
      const miss = await ApprovalService.previewRouting(owner, { documentType: "SUPPLIER_BILL", amount: "999.99", currency: "AUD" });
      expect(miss.matched).toBeNull();
      await expect(ApprovalService.previewRouting(acc1, { documentType: "SUPPLIER_BILL", amount: "5", currency: "AUD" })).rejects.toThrow(PermissionDeniedError);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("inbox", () => {
    it("shows 'waiting for me' by current role, 'I requested', and 'all' for admins only", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      const forAccountant = await ApprovalService.inbox(acc1);
      expect(forAccountant.waitingForMe.map((i) => i.id)).toEqual([request.id]);
      expect(forAccountant.waitingForMe[0]!.currentStep?.name).toBe("Finance");
      expect(forAccountant.waitingForMe[0]!.currentStep?.openedAt).toBeInstanceOf(Date);
      expect(forAccountant.pendingCount).toBe(1);
      expect(forAccountant.canSeeAll).toBe(false);
      expect(forAccountant.all).toEqual([]);
      const forCreator = await ApprovalService.inbox(creator);
      expect(forCreator.waitingForMe).toEqual([]);
      expect(forCreator.iRequested.map((i) => i.id)).toEqual([request.id]);
      expect((await ApprovalService.inbox(manager)).waitingForMe).toEqual([]);
      const forOwner = await ApprovalService.inbox(owner);
      expect(forOwner.canSeeAll).toBe(true);
      expect(forOwner.all.map((i) => i.id)).toEqual([request.id]);
      // Once acc1 approved nothing is waiting for them any more.
      await ApprovalService.decide(acc1, request.id, { decision: "APPROVE" });
      expect((await ApprovalService.inbox(acc1)).waitingForMe).toEqual([]);
    });

    it("detail is visible only to people involved (requester, assignee, admin), not to bystanders", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      expect((await ApprovalService.getDetail(creator, request.id)).steps).toHaveLength(1);
      expect((await ApprovalService.getDetail(acc1, request.id)).request.id).toBe(request.id);
      expect((await ApprovalService.getDetail(owner, request.id)).decisions).toEqual([]);
      await expect(ApprovalService.getDetail(employee, request.id)).rejects.toThrow(ApprovalRequestNotFoundError);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe("archived organisations and tenant isolation", () => {
    it("an archived organisation refuses decisions, overrides and policy changes", async () => {
      const policy = await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await db().update(organizations).set({ archivedAt: new Date() }).where(eq(organizations.id, orgId));
      await expect(ApprovalService.decide(acc1, request.id, { decision: "APPROVE" })).rejects.toThrow(OrganizationArchivedError);
      await expect(ApprovalService.override(owner, request.id, { outcome: "REJECT", reason: "archived org" })).rejects.toThrow(OrganizationArchivedError);
      await expect(ApprovalService.createPolicy(owner, billPolicy({ name: "More" }))).rejects.toThrow(OrganizationArchivedError);
      await expect(ApprovalService.setPolicyActive(owner, policy.id, false)).rejects.toThrow(OrganizationArchivedError);
      await expect(ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id)).rejects.toThrow(OrganizationArchivedError);
      expect((await requestsFor(bill.id))[0]!.status).toBe("PENDING");
    });

    it("another organisation can neither see nor decide this organisation's requests, nor use its policies", async () => {
      const policy = await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);

      const other = await createTestOrg("approvals-other");
      const stranger = other.owner;
      await expect(ApprovalService.decide(stranger, request.id, { decision: "APPROVE" })).rejects.toThrow(ApprovalRequestNotFoundError);
      await expect(ApprovalService.override(stranger, request.id, { outcome: "APPROVE", reason: "cross tenant" })).rejects.toThrow(ApprovalRequestNotFoundError);
      await expect(ApprovalService.reassign(stranger, request.id, { userIds: [stranger.userId], reason: "cross tenant" })).rejects.toThrow(ApprovalRequestNotFoundError);
      await expect(ApprovalService.getDetail(stranger, request.id)).rejects.toThrow(ApprovalRequestNotFoundError);
      await expect(ApprovalService.updatePolicy(stranger, policy.id, billPolicy())).rejects.toThrow();
      expect((await ApprovalService.inbox(stranger)).all).toEqual([]);
      expect(await ApprovalService.listPolicies(stranger)).toEqual([]);
      // Row-level security, not just service filters: a raw tenant-scoped query from the other org sees nothing.
      const raw = await withTenant(other.organizationId, async (tx) => tx.select().from(approvalRequests));
      expect(raw).toEqual([]);
      // A bill of this org does not trigger the other org's (nonexistent) policies and vice versa.
      expect((await ApprovalService.inbox(owner)).all).toHaveLength(1);
    });

    it("the decision log is append-only for the application role (no UPDATE, no DELETE)", async () => {
      await ApprovalService.createPolicy(owner, billPolicy());
      const bill = await draftBill(creator, "2000.00");
      const request = await ApprovalService.requestApproval(creator, "SUPPLIER_BILL", bill.id);
      await ApprovalService.decide(acc1, request.id, { decision: "APPROVE" });
      const update = await pgMessage(
        withTenant(orgId, (tx) => tx.update(approvalDecisions).set({ comment: "tampered" }).where(eq(approvalDecisions.requestId, request.id))),
      );
      expect(update).toMatch(/permission denied/i);
      const del = await pgMessage(withTenant(orgId, (tx) => tx.delete(approvalDecisions).where(eq(approvalDecisions.requestId, request.id))));
      expect(del).toMatch(/permission denied/i);
      const delRequest = await pgMessage(withTenant(orgId, (tx) => tx.delete(approvalRequests).where(eq(approvalRequests.id, request.id))));
      expect(delRequest).toMatch(/permission denied/i);
    });
  });
});
