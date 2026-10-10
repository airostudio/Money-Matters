import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/tenant";
import { invoiceLines, invoices, bills, billLines, organizationMemberships, auditLogs } from "@/db/schema";
import {
  OrganizationService,
  SeatLimitReachedError,
  WriteAccessConfirmationRequiredError,
} from "@/domain/organizations/organization-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { AccountService } from "@/domain/accounts/account-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { AutonomySettingsService } from "@/domain/ai-controller/autonomy";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { StaleEditError } from "@/domain/concurrency/stale-edit";
import { roleNeedsWriteConfirmation } from "@/domain/permissions/role-info";
import { membershipRoleEnum } from "@/db/schema";
import type { MembershipRole } from "@/domain/permissions/roles";
import { addTestMember, closeTestPools, createTestOrg, createTestUser, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";

describe("Sharing a company file — read-only members and concurrent editing", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let organizationId: string;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;
  let purchases: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("shared-access");
    owner = org.owner;
    organizationId = org.organizationId;
    sales = await createSalesFixtures(owner, org.baseCurrency);
    purchases = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  /** Tenant tables are RLS-scoped, so raw reads go through withTenant like the services do. */
  const inTenant = <T,>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(organizationId, fn);

  const invoiceInput = (memo?: string) => ({
    customerContactId: sales.customerContactId,
    issueDate: new Date("2026-01-01"),
    dueDate: new Date("2026-01-31"),
    currency: "AUD",
    arAccountId: sales.arAccountId,
    memo,
    lines: [{ description: "Consulting", quantity: "10", unitPrice: "100.00", accountId: sales.revenueAccountId, taxCodeId: sales.taxCodeId }],
  });

  const billInput = (memo?: string) => ({
    supplierContactId: purchases.supplierContactId,
    issueDate: new Date("2026-01-01"),
    dueDate: new Date("2026-01-31"),
    currency: "AUD",
    apAccountId: purchases.apAccountId,
    memo,
    lines: [{ description: "Materials", quantity: "2", unitPrice: "50.00", accountId: purchases.expenseAccountId, taxCodeId: purchases.taxCodeId }],
  });

  describe("a READ_ONLY member added through addMemberByEmail", () => {
    it("can read invoices, accounts, the ledger and reports", async () => {
      const draft = await InvoiceService.create(owner, invoiceInput());
      const viewer = await addTestMember(owner, "READ_ONLY", "Viewer");

      expect((await InvoiceService.list(viewer)).map((i) => i.id)).toContain(draft.id);
      expect((await InvoiceService.get(viewer, draft.id))?.id).toBe(draft.id);
      expect((await AccountService.list(viewer)).length).toBeGreaterThan(0);
      await expect(LedgerService.getTrialBalance(viewer)).resolves.toBeDefined();
      await expect(
        ReportingService.getProfitAndLoss(viewer, { from: new Date("2026-01-01"), to: new Date("2026-12-31") }),
      ).resolves.toBeDefined();
    });

    it("is refused at the service layer for every representative write, and nothing changes", async () => {
      const draft = await InvoiceService.create(owner, invoiceInput("original"));
      const bill = await BillService.create(owner, billInput("original"));
      const viewer = await addTestMember(owner, "READ_ONLY", "Viewer");
      const another = await createTestUser("Another");
      const invoiceCountBefore = (await inTenant((tx) => tx.select().from(invoices))).length;
      const billCountBefore = (await inTenant((tx) => tx.select().from(bills))).length;

      const refused: Array<[string, () => Promise<unknown>]> = [
        ["invoice create", () => InvoiceService.create(viewer, invoiceInput())],
        ["invoice update", () => InvoiceService.update(viewer, draft.id, invoiceInput("hacked"))],
        ["invoice delete draft", () => InvoiceService.deleteDraft(viewer, draft.id)],
        ["invoice approve-and-post", () => InvoiceService.approveAndPost(viewer, draft.id)],
        ["bill create", () => BillService.create(viewer, billInput())],
        ["bill update", () => BillService.update(viewer, bill.id, billInput("hacked"))],
        ["bill approve-and-post", () => BillService.approveAndPost(viewer, bill.id)],
        [
          "manual journal post",
          () =>
            PostingService.postJournal(viewer, {
              postingDate: new Date("2026-01-05"),
              memo: "sneaky",
              lines: [
                { accountId: sales.bankGlAccountId, debit: "10.00", currency: "AUD" },
                { accountId: sales.revenueAccountId, credit: "10.00", currency: "AUD" },
              ],
            }),
        ],
        ["member add", () => OrganizationService.addMemberByEmail(viewer, another.email, "READ_ONLY")],
        ["member add with confirmation flag", () => OrganizationService.addMemberByEmail(viewer, another.email, "OWNER", { confirmWriteAccess: true })],
        ["member role change", () => OrganizationService.updateMemberRole(viewer, "00000000-0000-0000-0000-000000000000", "OWNER", { confirmWriteAccess: true })],
        ["member remove", () => OrganizationService.removeMember(viewer, "00000000-0000-0000-0000-000000000000")],
        ["member list", () => OrganizationService.listMembers(viewer)],
        ["organization / AI autonomy setting change", () => AutonomySettingsService.setLevel(viewer, 2)],
        ["emergency stop", () => AutonomySettingsService.emergencyStop(viewer)],
        ["account create", () => AccountService.create(viewer, { code: "9999", name: "Nope", type: "EXPENSE", currency: "AUD" })],
      ];

      for (const [label, attempt] of refused) {
        await expect(attempt(), label).rejects.toBeInstanceOf(PermissionDeniedError);
      }

      // Nothing was created, edited or posted.
      expect((await inTenant((tx) => tx.select().from(invoices))).length).toBe(invoiceCountBefore);
      expect((await inTenant((tx) => tx.select().from(bills))).length).toBe(billCountBefore);
      const [after] = await inTenant((tx) => tx.select().from(invoices).where(eq(invoices.id, draft.id)));
      expect(after).toMatchObject({ status: "DRAFT", memo: "original" });
      const [billAfter] = await inTenant((tx) => tx.select().from(bills).where(eq(bills.id, bill.id)));
      expect(billAfter).toMatchObject({ status: "DRAFT", memo: "original" });
      const members = await inTenant((tx) => tx.select().from(organizationMemberships).where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true))));
      expect(members).toHaveLength(2); // owner + viewer only
    });

    it("an owner's work is unaffected by a viewer being signed in: the owner can still post", async () => {
      await addTestMember(owner, "READ_ONLY", "Viewer");
      const draft = await InvoiceService.create(owner, invoiceInput());
      await InvoiceService.approveAndPost(owner, draft.id);
      const posted = await InvoiceService.get(owner, draft.id);
      expect(posted?.status).toBe("APPROVED");
    });
  });

  describe("write-access confirmation is enforced server-side", () => {
    const writerRoles = membershipRoleEnum.enumValues.filter((r) => roleNeedsWriteConfirmation(r));

    it.each(writerRoles)("adding %s without the explicit confirmation is rejected and uses no seat", async (role) => {
      const guest = await createTestUser("Guest");
      await expect(OrganizationService.addMemberByEmail(owner, guest.email, role, { confirmWriteAccess: false })).rejects.toBeInstanceOf(
        WriteAccessConfirmationRequiredError,
      );
      const usage = await OrganizationService.getSeatUsage(organizationId);
      expect(usage.seatsUsed).toBe(1);
      // With the confirmation it works.
      await expect(OrganizationService.addMemberByEmail(owner, guest.email, role, { confirmWriteAccess: true })).resolves.toBeTruthy();
    });

    it("READ_ONLY needs no confirmation", async () => {
      const guest = await createTestUser("Guest");
      const m = await OrganizationService.addMemberByEmail(owner, guest.email, "READ_ONLY", { confirmWriteAccess: false });
      expect(m!.role).toBe("READ_ONLY");
    });

    it("changing a role to a writer role needs the confirmation; demoting to READ_ONLY does not (and is still audited)", async () => {
      const guest = await createTestUser("Guest");
      const m = await OrganizationService.addMemberByEmail(owner, guest.email, "READ_ONLY", { confirmWriteAccess: false });

      for (const role of ["OWNER", "ADMINISTRATOR", "ACCOUNTANT"] as MembershipRole[]) {
        await expect(OrganizationService.updateMemberRole(owner, m!.id, role, { confirmWriteAccess: false })).rejects.toBeInstanceOf(
          WriteAccessConfirmationRequiredError,
        );
      }
      const [still] = await inTenant((tx) => tx.select().from(organizationMemberships).where(eq(organizationMemberships.id, m!.id)));
      expect(still!.role).toBe("READ_ONLY");

      await OrganizationService.updateMemberRole(owner, m!.id, "ACCOUNTANT", { confirmWriteAccess: true });
      await OrganizationService.updateMemberRole(owner, m!.id, "READ_ONLY", { confirmWriteAccess: false });

      const changes = await inTenant((tx) => tx.select().from(auditLogs).where(eq(auditLogs.action, "membership.role_changed")));
      expect(changes).toHaveLength(2);
    });

    it("an unknown role is still reported as an invalid role, not a confirmation problem", async () => {
      const guest = await createTestUser("Guest");
      await expect(
        OrganizationService.addMemberByEmail(owner, guest.email, "GOD" as never, { confirmWriteAccess: false }),
      ).rejects.toThrow(/not a valid membership role/);
    });

    it("the seat limit is unchanged: with two seats a third member is still refused", async () => {
      const small = await createTestOrg("small-shared", { seatLimit: 2 });
      const second = await createTestUser("Second");
      const third = await createTestUser("Third");
      await OrganizationService.addMemberByEmail(small.owner, second.email, "READ_ONLY", { confirmWriteAccess: false });
      await expect(
        OrganizationService.addMemberByEmail(small.owner, third.email, "READ_ONLY", { confirmWriteAccess: false }),
      ).rejects.toBeInstanceOf(SeatLimitReachedError);
    });
  });

  describe("optimistic concurrency on draft documents", () => {
    it("two sessions editing the same draft invoice: the second save gets StaleEditError and the first save is intact", async () => {
      const draft = await InvoiceService.create(owner, invoiceInput("start"));
      const colleague = await addTestMember(owner, "ACCOUNTANT", "Priya");

      // Both open the edit form at the same moment.
      const openedByOwner = await InvoiceService.get(owner, draft.id);
      const openedByColleague = await InvoiceService.get(colleague, draft.id);
      expect(openedByOwner!.editVersion).toBe(openedByColleague!.editVersion);

      // Owner saves first.
      await InvoiceService.update(owner, draft.id, { ...invoiceInput("owner's edit"), expectedVersion: openedByOwner!.editVersion });

      // Colleague's save is based on the old version.
      const error = await InvoiceService.update(colleague, draft.id, {
        ...invoiceInput("colleague's edit"),
        lines: [{ description: "Different", quantity: "1", unitPrice: "1.00", accountId: sales.revenueAccountId }],
        expectedVersion: openedByColleague!.editVersion,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(StaleEditError);
      expect(error.message).toContain("Owner"); // the person who changed it
      expect(error.message).toContain("Reload the page");

      // The first save's data is intact, including its lines.
      const current = await InvoiceService.get(owner, draft.id);
      expect(current!.memo).toBe("owner's edit");
      expect(current!.lines).toHaveLength(1);
      expect(current!.lines[0]!.description).toBe("Consulting");
      expect(current!.total).toBe("1100.0000");

      // After reloading, the colleague's save goes through.
      await InvoiceService.update(colleague, draft.id, { ...invoiceInput("colleague's edit"), expectedVersion: current!.editVersion });
      expect((await InvoiceService.get(owner, draft.id))!.memo).toBe("colleague's edit");
    });

    it("truly simultaneous saves: exactly one wins, the other is stale, no data is mixed", async () => {
      const draft = await InvoiceService.create(owner, invoiceInput("start"));
      const colleague = await addTestMember(owner, "ACCOUNTANT", "Priya");
      const opened = (await InvoiceService.get(owner, draft.id))!.editVersion;

      const results = await Promise.allSettled([
        InvoiceService.update(owner, draft.id, { ...invoiceInput("A"), expectedVersion: opened }),
        InvoiceService.update(colleague, draft.id, { ...invoiceInput("B"), expectedVersion: opened }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.reason).toBeInstanceOf(StaleEditError);
      const lines = await inTenant((tx) => tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, draft.id)));
      expect(lines).toHaveLength(1);
    });

    it("a form with a missing or garbled version is treated as stale, while programmatic callers that omit it still work", async () => {
      const draft = await InvoiceService.create(owner, invoiceInput("start"));
      await expect(InvoiceService.update(owner, draft.id, { ...invoiceInput("x"), expectedVersion: "" })).rejects.toBeInstanceOf(StaleEditError);
      await expect(InvoiceService.update(owner, draft.id, { ...invoiceInput("x"), expectedVersion: "garbage" })).rejects.toBeInstanceOf(StaleEditError);
      await InvoiceService.update(owner, draft.id, invoiceInput("programmatic"));
      expect((await InvoiceService.get(owner, draft.id))!.memo).toBe("programmatic");
    });

    it("two sessions editing the same draft bill: the second save gets StaleEditError and the first save is intact", async () => {
      const draft = await BillService.create(owner, billInput("start"));
      const colleague = await addTestMember(owner, "BOOKKEEPER", "Sam");
      const openedByOwner = await BillService.get(owner, draft.id);
      const openedByColleague = await BillService.get(colleague, draft.id);

      await BillService.update(owner, draft.id, { ...billInput("owner's edit"), expectedVersion: openedByOwner!.editVersion });
      const error = await BillService.update(colleague, draft.id, {
        ...billInput("colleague's edit"),
        expectedVersion: openedByColleague!.editVersion,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(StaleEditError);
      expect(error.message).toContain("bill");

      const current = await BillService.get(owner, draft.id);
      expect(current!.memo).toBe("owner's edit");
      const lines = await inTenant((tx) => tx.select().from(billLines).where(eq(billLines.billId, draft.id)));
      expect(lines).toHaveLength(1);

      await BillService.update(colleague, draft.id, { ...billInput("colleague's edit"), expectedVersion: current!.editVersion });
      expect((await BillService.get(owner, draft.id))!.memo).toBe("colleague's edit");
    });

    it("simultaneous bill saves: exactly one wins", async () => {
      const draft = await BillService.create(owner, billInput("start"));
      const colleague = await addTestMember(owner, "BOOKKEEPER", "Sam");
      const opened = (await BillService.get(owner, draft.id))!.editVersion;
      const results = await Promise.allSettled([
        BillService.update(owner, draft.id, { ...billInput("A"), expectedVersion: opened }),
        BillService.update(colleague, draft.id, { ...billInput("B"), expectedVersion: opened }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r): r is PromiseRejectedResult => r.status === "rejected")[0]!.reason).toBeInstanceOf(StaleEditError);
    });
  });
});
