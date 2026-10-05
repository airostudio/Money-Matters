import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { D, seedCloseScenario, type CloseScenario } from "../../helpers/close";
import { createFixedAssetFixtures } from "../../helpers/fixed-assets";
import { withTenant } from "@/db/tenant";
import { auditLogs, fiscalPeriods, journalEntries, periodCloses, periodLockEvents } from "@/db/schema";
import { FixedAssetService } from "@/domain/fixed-assets/fixed-asset-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { PeriodLockedError } from "@/domain/ledger/errors";
import { PeriodCloseService } from "@/domain/close/period-close-service";
import { PeriodLockService } from "@/domain/close/period-lock-service";
import { CloseChecklistService } from "@/domain/close/checklist-service";
import {
  CloseAcknowledgementRequiredError,
  CloseBlockedError,
  PeriodLockChangeError,
  SignoffError,
} from "@/domain/close/errors";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";

const REASON = "Supplier invoice arrived after close";
const ALL_MANUAL = ["manual.accruals", "manual.prepayments", "manual.tax_review", "manual.pnl_review", "manual.balance_sheet_review"];

describe("Month-end close and reopen workflow (Phase 9 Slice 3)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let accountant: Actor;
  let orgId: string;
  let currency: string;
  let s: CloseScenario;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("close-workflow");
    owner = org.owner;
    accountant = actorWithRole(owner, "ACCOUNTANT");
    orgId = org.organizationId;
    currency = org.baseCurrency;
    s = await seedCloseScenario(owner, currency);
  });

  const draftJournal = (date: string) => ({
    postingDate: D(date),
    lines: [
      { accountId: s.bankGl, debit: "10.00", currency },
      { accountId: s.revenue, credit: "10.00", currency },
    ],
  });

  /** Fix everything automatic and sign off every manual item that applies. */
  async function makeFullyClean() {
    await s.categorize();
    await s.approveInvoice();
    for (const key of ALL_MANUAL) await PeriodCloseService.signOff(accountant, "2026-09", key);
    await PeriodCloseService.signOff(accountant, "2026-09", "manual.foreign_exchange").catch(() => undefined);
  }

  const periodRow = (key = "2026-09") =>
    withTenant(orgId, async (tx) => {
      const [row] = await tx.select().from(fiscalPeriods).where(eq(fiscalPeriods.label, key));
      return row!;
    });

  const events = (periodId: string) =>
    withTenant(orgId, (tx) => tx.select().from(periodLockEvents).where(eq(periodLockEvents.fiscalPeriodId, periodId)).orderBy(periodLockEvents.createdAt));

  const audit = (action: string) =>
    withTenant(orgId, (tx) => tx.select().from(auditLogs).where(eq(auditLogs.action, action)).orderBy(desc(auditLogs.createdAt)));

  describe("closing", () => {
    it("is refused with a typed error listing every BLOCKING item, and leaves the period untouched", async () => {
      const fa = await createFixedAssetFixtures(owner, currency);
      await FixedAssetService.registerAsset(owner, {
        assetClassId: fa.assetClassId,
        name: "Unposted laptop",
        acquisitionDate: D("2026-08-01"),
        acquisitionCost: "5000.00",
        assetAccountId: fa.assetAccountId,
        accumulatedDepreciationAccountId: fa.accumulatedDepreciationAccountId,
        depreciationExpenseAccountId: fa.depreciationExpenseAccountId,
        usefulLifeMonths: 36,
      });

      const error = await PeriodCloseService.close(accountant, "2026-09", { acknowledgeOutstanding: true }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(CloseBlockedError);
      const blocked = error as CloseBlockedError;
      expect(blocked.items.map((i) => i.id)).toEqual(["assets.register_reconciles"]);
      expect(blocked.message).toContain("blocking item");
      expect(blocked.message).toContain("do not reconcile to the general ledger");

      // Nothing happened: no period row was created, no lock event, no close cycle.
      await withTenant(orgId, async (tx) => {
        expect(await tx.select().from(fiscalPeriods)).toHaveLength(0);
        expect(await tx.select().from(periodLockEvents)).toHaveLength(0);
        expect(await tx.select().from(periodCloses)).toHaveLength(0);
      });
    });

    it("with outstanding ATTENTION / unsigned items needs an explicit acknowledgement, which is captured in the audit record with the checklist snapshot", async () => {
      const refused = await PeriodCloseService.close(accountant, "2026-09").then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(CloseAcknowledgementRequiredError);
      const outstandingIds = (refused as CloseAcknowledgementRequiredError).items.map((i) => i.id);
      expect(outstandingIds).toEqual(expect.arrayContaining(["sales.draft_invoices", "manual.accruals"]));
      expect(await withTenant(orgId, (tx) => tx.select().from(fiscalPeriods))).toHaveLength(0);

      const result = await PeriodCloseService.close(accountant, "2026-09", { acknowledgeOutstanding: true });
      // Default lock level: SOFT_LOCKED.
      expect(result.period.status).toBe("SOFT_LOCKED");
      expect(result.close).toMatchObject({ status: "CLOSED", cycle: 1, lockLevelApplied: "SOFT_LOCKED", closedById: owner.userId, acknowledgedAttentionCount: outstandingIds.length });
      expect(result.close.closedAt).toBeInstanceOf(Date);

      const [entry] = await audit("period.closed");
      expect(entry).toMatchObject({ entityType: "FiscalPeriod", entityId: result.period.id, actorUserId: owner.userId });
      const after = entry!.after as { status: string; outstandingAcknowledged: string[]; summary: string; checklistSnapshot: { items: unknown[]; progress: { percent: number } } };
      expect(after.status).toBe("SOFT_LOCKED");
      expect(after.outstandingAcknowledged).toEqual(expect.arrayContaining(outstandingIds));
      expect(after.summary).toMatch(/closed with \d+ outstanding item\(s\) acknowledged/);
      // The durable snapshot: what the state was at close time (a flagged draft invoice and an unreconciled bank item).
      expect(after.checklistSnapshot.items.length).toBeGreaterThan(8);
      expect(JSON.stringify(after.checklistSnapshot)).toContain("bank.unreconciled:");
      expect(JSON.stringify(result.close.checklistSnapshot)).toContain("sales.draft_invoices");

      const ev = await events(result.period.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ eventType: "LOCKED", fromLevel: "OPEN", toLevel: "SOFT_LOCKED", actorRole: "ACCOUNTANT", periodCloseId: result.close.id });
      expect(ev[0]!.reason).toMatch(/outstanding item\(s\) acknowledged/);
    });

    it("a fully clean period closes with no acknowledgement; the snapshot shows 100% and system vs human attribution", async () => {
      await makeFullyClean();
      const checklist = await CloseChecklistService.compute(owner, "2026-09");
      expect(checklist.progress.percent).toBe(100);
      expect(checklist.outstanding).toEqual([]);

      const result = await PeriodCloseService.close(owner, "2026-09", { lockLevel: "HARD_LOCKED" });
      expect(result.period.status).toBe("HARD_LOCKED");
      expect(result.close.acknowledgedAttentionCount).toBe(0);
      const snapshot = result.close.checklistSnapshot as { items: Array<{ id: string; kind: string; verifiedBy: string | null }>; progress: { percent: number } };
      expect(snapshot.progress.percent).toBe(100);
      expect(snapshot.items.find((i) => i.id === "manual.accruals")).toMatchObject({ kind: "MANUAL", verifiedBy: "HUMAN" });
      expect(snapshot.items.find((i) => i.id === "ledger.trial_balance")).toMatchObject({ kind: "AUTOMATIC", verifiedBy: "SYSTEM" });
    });

    it("needs period:close — bookkeeper, manager and read-only cannot; an AI actor cannot even with an OWNER role", async () => {
      for (const role of ["BOOKKEEPER", "MANAGER", "READ_ONLY", "EMPLOYEE", "ACCOUNTS_PAYABLE"] as const) {
        await expect(PeriodCloseService.close(actorWithRole(owner, role), "2026-09", { acknowledgeOutstanding: true }), role).rejects.toThrow(PermissionDeniedError);
      }
      await expect(PeriodCloseService.close({ ...owner, type: "AI" }, "2026-09", { acknowledgeOutstanding: true })).rejects.toThrow(PermissionDeniedError);
      await expect(PeriodCloseService.signOff({ ...owner, type: "AI" }, "2026-09", "manual.accruals")).rejects.toThrow(PermissionDeniedError);
      await expect(PeriodLockService.reopen({ ...owner, type: "AI" }, "2026-09", { reason: REASON })).rejects.toThrow(PermissionDeniedError);
      await expect(PeriodLockService.raise({ ...owner, type: "SYSTEM" }, "2026-09", "HARD_LOCKED")).rejects.toThrow(PermissionDeniedError);
      expect(await withTenant(orgId, (tx) => tx.select().from(fiscalPeriods))).toHaveLength(0);
    });

    it("refuses an invalid level, and refuses to close a period that is already at or above that level", async () => {
      await expect(PeriodCloseService.close(owner, "2026-09", { lockLevel: "OPEN" as never, acknowledgeOutstanding: true })).rejects.toThrow(PeriodLockChangeError);
      await PeriodCloseService.close(owner, "2026-09", { lockLevel: "HARD_LOCKED", acknowledgeOutstanding: true });
      await expect(PeriodCloseService.close(owner, "2026-09", { lockLevel: "SOFT_LOCKED", acknowledgeOutstanding: true })).rejects.toThrow(/already/);
    });

    it("sign-offs cannot be changed on a locked period (reopen first)", async () => {
      await PeriodCloseService.close(owner, "2026-09", { acknowledgeOutstanding: true });
      await expect(PeriodCloseService.signOff(owner, "2026-09", "manual.accruals")).rejects.toThrow(SignoffError);
    });

    it("sequencing: closing out of order requires acknowledging the earlier open period", async () => {
      await s.categorize();
      await s.approveInvoice();
      await PostingService.postJournal(owner, draftJournal("2026-10-05"));
      for (const key of ALL_MANUAL) await PeriodCloseService.signOff(owner, "2026-10", key);
      const refused = await PeriodCloseService.close(owner, "2026-10").then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(CloseAcknowledgementRequiredError);
      expect((refused as CloseAcknowledgementRequiredError).items.map((i) => i.id)).toContain("ledger.prior_period");
      await expect(PeriodCloseService.close(owner, "2026-10", { acknowledgeOutstanding: true })).resolves.toBeDefined();
    });
  });

  describe("posting after a close", () => {
    it("a normal post is rejected; an authorised role can post with a reason (recorded); the history shows the override", async () => {
      const closed = await PeriodCloseService.close(owner, "2026-09", { acknowledgeOutstanding: true });
      await expect(PostingService.postJournal(actorWithRole(owner, "BOOKKEEPER"), draftJournal("2026-09-20"))).rejects.toThrow(PeriodLockedError);
      await expect(PostingService.postJournal(accountant, draftJournal("2026-09-20"))).rejects.toThrow(/post anyway/i);
      const posted = await PostingService.postJournal(accountant, draftJournal("2026-09-20"), { lockOverrideReason: REASON });

      const ev = await events(closed.period.id);
      expect(ev.map((e) => e.eventType)).toEqual(["LOCKED", "POSTING_OVERRIDE"]);
      expect(ev[1]).toMatchObject({ journalEntryId: posted.entryId, reason: REASON });
      await withTenant(orgId, async (tx) => {
        const [j] = await tx.select().from(journalEntries).where(eq(journalEntries.id, posted.entryId));
        expect(j!.lockOverrideReason).toBe(REASON);
      });
    });
  });

  describe("approve-and-post under a lock", () => {
    it("an invoice approve-and-post into a soft-locked period is refused (leaving the invoice a DRAFT with no journal), offers the override to an authorised role, and posts with a reason", async () => {
      await PeriodCloseService.close(owner, "2026-09", { acknowledgeOutstanding: true });
      const bookkeeper = actorWithRole(owner, "BOOKKEEPER");

      const refused = await InvoiceService.approveAndPost(bookkeeper, s.draftInvoiceId).then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(PeriodLockedError);
      expect((refused as PeriodLockedError).canOverrideWithReason).toBe(false);
      const stillDraft = await InvoiceService.get(owner, s.draftInvoiceId);
      expect(stillDraft).toMatchObject({ status: "DRAFT", journalEntryId: null });

      const needsReason = await InvoiceService.approveAndPost(accountant, s.draftInvoiceId).then(() => null, (e: unknown) => e);
      expect((needsReason as PeriodLockedError).canOverrideWithReason).toBe(true);

      const posted = await InvoiceService.approveAndPost(accountant, s.draftInvoiceId, { lockOverrideReason: REASON });
      expect(posted.status).toBe("APPROVED");
      await withTenant(orgId, async (tx) => {
        const [j] = await tx.select().from(journalEntries).where(eq(journalEntries.id, posted.journalEntryId!));
        expect(j).toMatchObject({ lockOverrideLevel: "SOFT_LOCKED", lockOverrideReason: REASON });
      });
    });

    it("a bill approve-and-post is subject to the same lock and the same override", async () => {
      const purchases = await createPurchasesFixtures(owner, currency);
      const bill = await BillService.create(owner, {
        supplierContactId: purchases.supplierContactId,
        issueDate: D("2026-09-12"),
        dueDate: D("2026-10-12"),
        currency,
        apAccountId: purchases.apAccountId,
        lines: [{ description: "Supplies", quantity: "1", unitPrice: "80.00", accountId: purchases.expenseAccountId }],
      });
      await PeriodCloseService.close(owner, "2026-09", { acknowledgeOutstanding: true });
      await expect(BillService.approveAndPost(actorWithRole(owner, "BOOKKEEPER"), bill.id)).rejects.toThrow(PeriodLockedError);
      const posted = await BillService.approveAndPost(accountant, bill.id, { lockOverrideReason: REASON });
      expect(posted.status).toBe("APPROVED");
    });
  });

  describe("reopen", () => {
    async function closeWith(level: "SOFT_LOCKED" | "ADVISOR_LOCKED" | "TAX_LOCKED" | "HARD_LOCKED") {
      return PeriodCloseService.close(owner, "2026-09", { lockLevel: level, acknowledgeOutstanding: true });
    }

    it("requires period:reopen and a reason (min length) — both enforced, nothing changes on refusal", async () => {
      const closed = await closeWith("SOFT_LOCKED");
      const snapshot = async () => ({ events: (await events(closed.period.id)).length, audits: (await audit("period.reopened")).length, status: (await periodRow()).status });
      const before = await snapshot();

      await expect(PeriodLockService.reopen(actorWithRole(owner, "BOOKKEEPER"), "2026-09", { reason: REASON })).rejects.toThrow(PermissionDeniedError);
      await expect(PeriodLockService.reopen(actorWithRole(owner, "MANAGER"), "2026-09", { reason: REASON })).rejects.toThrow(PermissionDeniedError);
      await expect(PeriodLockService.reopen(accountant, "2026-09", { reason: "" })).rejects.toThrow(/reason/i);
      await expect(PeriodLockService.reopen(accountant, "2026-09", { reason: "short" })).rejects.toThrow(PeriodLockChangeError);
      expect(await snapshot()).toEqual(before);
    });

    it("records who/when/why and before/after in BOTH the append-only history and the org audit log, and opens a new close cycle", async () => {
      const closed = await closeWith("SOFT_LOCKED");
      const { period, cycle } = await PeriodLockService.reopen(accountant, "2026-09", { reason: REASON });
      expect(period.status).toBe("OPEN");
      expect(period.lockedAt).toBeNull();
      expect(cycle).toBe(2);

      const ev = await events(closed.period.id);
      const reopened = ev.find((e) => e.eventType === "REOPENED")!;
      expect(reopened).toMatchObject({ fromLevel: "SOFT_LOCKED", toLevel: "OPEN", reason: REASON, actorUserId: owner.userId, actorRole: "ACCOUNTANT" });
      expect(reopened.createdAt).toBeInstanceOf(Date);

      const [a] = await audit("period.reopened");
      expect(a).toMatchObject({ entityId: closed.period.id, actorUserId: owner.userId });
      expect(a!.before).toMatchObject({ status: "SOFT_LOCKED" });
      expect(a!.after).toMatchObject({ status: "OPEN", reason: REASON, newCycle: 2, previousCycle: 1 });

      // Posting works again with no override…
      await expect(PostingService.postJournal(actorWithRole(owner, "BOOKKEEPER"), draftJournal("2026-09-21"))).resolves.toBeDefined();
      // …and posted history was never touched by the reopen.
      await withTenant(orgId, async (tx) => {
        const rows = await tx.select({ s: journalEntries.status }).from(journalEntries).where(and(eq(journalEntries.organizationId, orgId)));
        expect(rows.every((r) => r.s === "POSTED" || r.s === "DRAFT")).toBe(true);
      });
    });

    it("TAX_LOCKED and HARD_LOCKED need the higher permission: an accountant is refused, an administrator/owner is allowed", async () => {
      for (const level of ["TAX_LOCKED", "HARD_LOCKED"] as const) {
        await resetDatabase();
        const org = await createTestOrg("close-reopen");
        owner = org.owner;
        orgId = org.organizationId;
        currency = org.baseCurrency;
        s = await seedCloseScenario(owner, currency);
        accountant = actorWithRole(owner, "ACCOUNTANT");
        await closeWith(level);
        const ack = "I understand this may invalidate a lodgement";
        await expect(PeriodLockService.reopen(accountant, "2026-09", { reason: REASON, acknowledgement: ack }), level).rejects.toThrow(/period:reopen_hard/);
        const admin = actorWithRole(owner, "ADMINISTRATOR");
        await expect(PeriodLockService.reopen(admin, "2026-09", { reason: REASON, acknowledgement: ack }), level).resolves.toMatchObject({ period: { status: "OPEN" } });
      }
    });

    it("reopening a TAX_LOCKED period also requires the typed acknowledgement that it may invalidate a lodgement", async () => {
      await closeWith("TAX_LOCKED");
      const error = await PeriodLockService.reopen(owner, "2026-09", { reason: REASON }).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(PeriodLockChangeError);
      expect((error as PeriodLockChangeError).problem).toBe("TAX_ACKNOWLEDGEMENT_REQUIRED");
      await expect(PeriodLockService.reopen(owner, "2026-09", { reason: REASON, acknowledgement: "ok" })).rejects.toThrow(PeriodLockChangeError);
      expect((await periodRow()).status).toBe("TAX_LOCKED");

      const ack = "Acknowledged: this may invalidate a lodgement already made.";
      await PeriodLockService.reopen(owner, "2026-09", { reason: REASON, acknowledgement: ack });
      const ev = (await events((await periodRow()).id)).find((e) => e.eventType === "REOPENED")!;
      expect(ev.acknowledgement).toBe(ack);
      const [a] = await audit("period.reopened");
      expect((a!.after as { acknowledgement: string }).acknowledgement).toBe(ack);
    });

    it("can lower to an intermediate level (HARD -> ADVISOR) which records LEVEL_LOWERED, and lowering is the only thing reopen does", async () => {
      const closed = await closeWith("HARD_LOCKED");
      await PeriodLockService.reopen(owner, "2026-09", { reason: REASON, toLevel: "ADVISOR_LOCKED" });
      expect((await events(closed.period.id)).map((e) => e.eventType)).toEqual(["LOCKED", "LEVEL_LOWERED"]);
      await expect(PeriodLockService.reopen(owner, "2026-09", { reason: REASON, toLevel: "HARD_LOCKED" })).rejects.toThrow(PeriodLockChangeError);
      // The accountant can finish the job from ADVISOR (below the tax/hard tier).
      await expect(PeriodLockService.reopen(accountant, "2026-09", { reason: REASON })).resolves.toBeDefined();
    });

    it("cannot reopen a period that was never locked", async () => {
      await expect(PeriodLockService.reopen(owner, "2026-09", { reason: REASON })).rejects.toThrow(/never been locked/);
      const other = await PeriodLockService.raise(owner, "2026-08", "SOFT_LOCKED");
      await PeriodLockService.reopen(owner, "2026-08", { reason: REASON });
      await expect(PeriodLockService.reopen(owner, { kind: "id", id: other.id }, { reason: REASON })).rejects.toThrow(PeriodLockChangeError);
    });

    it("re-closing after a reopen starts a fresh cycle: sign-offs must be redone, the first close stays as immutable history", async () => {
      await makeFullyClean();
      const first = await PeriodCloseService.close(owner, "2026-09", { lockLevel: "SOFT_LOCKED" });
      expect(first.close.cycle).toBe(1);

      await PeriodLockService.reopen(owner, "2026-09", { reason: REASON });
      const midway = await CloseChecklistService.compute(owner, "2026-09");
      // The cycle-1 sign-offs no longer count: the manual items are open again.
      expect(midway.items.find((i) => i.id === "manual.accruals")).toMatchObject({ status: "MANUAL", signoff: null });
      expect(midway.progress.percent).toBeLessThan(100);

      // A correcting entry goes into the (re)opened period.
      await PostingService.postJournal(accountant, draftJournal("2026-09-25"));

      const second = await PeriodCloseService.close(owner, "2026-09", { lockLevel: "HARD_LOCKED", acknowledgeOutstanding: true });
      expect(second.close.cycle).toBe(2);
      expect(second.close.id).not.toBe(first.close.id);
      expect(second.close.acknowledgedAttentionCount).toBeGreaterThan(0);

      const workspace = await PeriodCloseService.getWorkspace(owner, "2026-09");
      expect(workspace.cycles.map((c) => [c.cycle, c.status, c.lockLevelApplied])).toEqual([
        [2, "CLOSED", "HARD_LOCKED"],
        [1, "CLOSED", "SOFT_LOCKED"],
      ]);
      expect(workspace.cycles[1]!.percentAtClose).toBe(100);
      // Full lock-event timeline, newest first: LOCKED(hard) , REOPENED, LOCKED(soft).
      expect(workspace.events.map((e) => e.eventType)).toEqual(["LOCKED", "REOPENED", "LOCKED"]);
      expect(workspace.events.map((e) => e.toLevel)).toEqual(["HARD_LOCKED", "OPEN", "SOFT_LOCKED"]);
      expect(workspace.events[1]).toMatchObject({ reason: REASON, actorRole: "OWNER" });
      expect(workspace.checklist.period.lockLevel).toBe("HARD_LOCKED");
    });
  });

  describe("raising a lock after the fact", () => {
    it("raise tightens a closed period (SOFT -> TAX) with a LOCKED event; lowering through raise is refused", async () => {
      const closed = await PeriodCloseService.close(owner, "2026-09", { acknowledgeOutstanding: true });
      await PeriodLockService.raise(accountant, "2026-09", "TAX_LOCKED", "BAS lodged on 28 Oct");
      const ev = await events(closed.period.id);
      expect(ev.map((e) => [e.eventType, e.fromLevel, e.toLevel])).toEqual([
        ["LOCKED", "OPEN", "SOFT_LOCKED"],
        ["LOCKED", "SOFT_LOCKED", "TAX_LOCKED"],
      ]);
      expect(ev[1]!.reason).toBe("BAS lodged on 28 Oct");
      await expect(PeriodLockService.raise(accountant, "2026-09", "SOFT_LOCKED")).rejects.toThrow(PeriodLockChangeError);
      await expect(PeriodLockService.raise(actorWithRole(owner, "BOOKKEEPER"), "2026-09", "HARD_LOCKED")).rejects.toThrow(PermissionDeniedError);
    });
  });
});
