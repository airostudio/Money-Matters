import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestPools, createTestUser, pgMessage, resetDatabase } from "../../helpers/db";
import { createPracticeWorld, revokeConsent, type PracticeWorld } from "../../helpers/practice";
import { tracker } from "../../helpers/connection-tracker";
import { withTenant } from "@/db/tenant";
import { withUserScope } from "@/db/user-scope";
import {
  auditLogs,
  journalEntries,
  journalLines,
  practiceAuditLogs,
  uploadedReceipts,
  workpaperAdjustments,
  workpaperEvidence,
  workpaperReviewNotes,
  workpaperScheduleLines,
  workpaperSignoffs,
  workpaperSnapshots,
  workpapers,
} from "@/db/schema";
import { AccountService } from "@/domain/accounts/account-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { PracticeService } from "@/domain/practice/practice-service";
import { PracticeConsentService } from "@/domain/practice/consent-service";
import { LinkNotActiveError, PracticePermissionError } from "@/domain/practice/errors";
import {
  DuplicateWorkpaperError,
  NotABalanceSheetAccountError,
  SignoffRuleError,
  WorkpaperNotFoundError,
  WorkpaperService,
  WorkpaperStateError,
} from "@/domain/practice/workpaper-service";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import { DocumentFileTooLargeError, UnsupportedDocumentFileTypeError } from "@/domain/documents/document-validation";

vi.mock("@/db/tenant", async (orig) => (await import("../../helpers/connection-tracker")).instrumentTenant(await orig<typeof import("@/db/tenant")>()));
vi.mock("@/db/user-scope", async (orig) => (await import("../../helpers/connection-tracker")).instrumentUserScope(await orig<typeof import("@/db/user-scope")>()));

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const PDF = { fileName: "statement.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4 statement") };
const NOW = new Date("2026-10-05T09:00:00Z");

describe("Workpapers (master spec s.43) — balance-sheet account reconciliation, hand-verified", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let w: PracticeWorld;
  let bankId: string;
  let revenueId: string;
  const A = () => w.clients.A.organizationId;
  const owner = () => w.clients.A.owner;

  /** Client A: bank 12,000.00 as at 30 Sep 2026 (and a later October movement that must NOT be in the September balance). */
  const seedLedger = async () => {
    const bank = await AccountService.create(owner(), { code: "1000", name: "Business Bank Account", type: "ASSET", currency: "AUD" });
    const capital = await AccountService.create(owner(), { code: "3100", name: "Owner Capital", type: "EQUITY", currency: "AUD" });
    const revenue = await AccountService.create(owner(), { code: "4000", name: "Sales", type: "REVENUE", currency: "AUD" });
    bankId = bank.id;
    revenueId = revenue.id;
    await PostingService.postJournal(owner(), {
      postingDate: D("2026-09-15"),
      memo: "Capital introduced",
      lines: [
        { accountId: bank.id, debit: "12000.00", currency: "AUD" },
        { accountId: capital.id, credit: "12000.00", currency: "AUD" },
      ],
    });
    await PostingService.postJournal(owner(), {
      postingDate: D("2026-10-10"),
      memo: "October sale",
      lines: [
        { accountId: bank.id, debit: "500.00", currency: "AUD" },
        { accountId: revenue.id, credit: "500.00", currency: "AUD" },
      ],
    });
  };

  beforeEach(async () => {
    await resetDatabase();
    w = await createPracticeWorld();
    await seedLedger();
    tracker.reset();
  });

  const create = (periodEnd = "2026-09-30") => WorkpaperService.create(w.s1Actor, w.practiceId, { clientOrganizationId: A(), accountId: bankId, periodEnd }, NOW);
  const reconcilingSchedule = [
    { kind: "SUPPORTING_BALANCE" as const, description: "Bank statement balance", reference: "Everyday acct stmt 30/09", amount: "12450.00" },
    { kind: "RECONCILING_ITEM" as const, description: "Outstanding cheques", reference: "chq 1043", amount: "-450.00" },
  ];

  describe("creating a workpaper pulls a labelled point-in-time snapshot", () => {
    it("reads the account balance as at the period end through S1's real role, sequentially, and labels it", async () => {
      const { id } = await create();
      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.workpaper).toMatchObject({
        accountCode: "1000",
        accountName: "Business Bank Account",
        accountType: "ASSET",
        periodEnd: "2026-09-30",
        status: "DRAFT",
        version: 1,
        ledgerBalance: "12000.00", // the 500.00 October sale is after the period end and is NOT in it
        preparedByName: "StaffOne",
        snapshotTakenByName: "StaffOne",
      });
      expect(d.provenance).toContain("Per the client's ledger as at 2026-09-30, pulled 2026-10-05T09:00:00.000Z by StaffOne");
      expect(d.provenance).toContain("point-in-time snapshot");
      expect(d.snapshots).toMatchObject([{ version: 1, ledgerBalance: "12000.00", takenByName: "StaffOne", takenByRole: "ACCOUNTANT" }]);
      expect(d.freshness).toMatchObject({ checked: true, stale: false, currentBalance: "12000.0000", change: "0.00" });
      expect(tracker.maxActive).toBe(1);
    });

    it("one workpaper per account and period; balance-sheet accounts only", async () => {
      await create();
      await expect(create()).rejects.toBeInstanceOf(DuplicateWorkpaperError);
      await expect(WorkpaperService.create(w.s1Actor, w.practiceId, { clientOrganizationId: A(), accountId: revenueId, periodEnd: "2026-09-30" }, NOW)).rejects.toBeInstanceOf(
        NotABalanceSheetAccountError,
      );
    });

    it("needs financial_report:read and journal:read in the client: a role without them cannot pull a balance", async () => {
      const membershipId = (await OrganizationService.listMembers(owner())).find((m) => m.userId === w.s1.id)!.membershipId;
      await OrganizationService.updateMemberRole(owner(), membershipId, "EMPLOYEE");
      await expect(create()).rejects.toThrow(/does not have permission|not a member|permission/i);
    });

    it("refuses a client the staff member cannot read: not a member, pending, revoked — and opens no tenant transaction for it", async () => {
      tracker.reset();
      const base = { accountId: bankId, periodEnd: "2026-09-30" };
      await expect(WorkpaperService.create(w.s1Actor, w.practiceId, { clientOrganizationId: w.clients.B.organizationId, ...base }, NOW)).rejects.toBeInstanceOf(LinkNotActiveError);
      await expect(WorkpaperService.create(w.s1Actor, w.practiceId, { clientOrganizationId: w.clients.C.organizationId, ...base }, NOW)).rejects.toBeInstanceOf(LinkNotActiveError);
      await expect(WorkpaperService.create(w.s1Actor, w.practiceId, { clientOrganizationId: w.clients.D.organizationId, ...base }, NOW)).rejects.toThrow(/not a member/);
      expect(tracker.tenantCalls).toEqual([]);
    });
  });

  describe("reconciliation schedule and difference (exact decimals)", () => {
    it("ledger 12,000.00 = bank statement 12,450.00 + outstanding items -450.00: difference 0.00, reconciled", async () => {
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, reconcilingSchedule);
      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.reconciliation).toEqual({ ledgerBalance: "12000.00", scheduleTotal: "12000.00", difference: "0.00", isReconciled: true });
      expect(d.lines.map((l) => [l.lineNumber, l.kind, l.amount])).toEqual([[1, "SUPPORTING_BALANCE", "12450.00"], [2, "RECONCILING_ITEM", "-450.00"]]);
    });

    it("a 100.00 discrepancy: items of -350.00 give a difference of -100.00, and signing needs an explicit acknowledgement", async () => {
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, [reconcilingSchedule[0]!, { ...reconcilingSchedule[1]!, amount: "-350.00" }]);
      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.reconciliation).toEqual({ ledgerBalance: "12000.00", scheduleTotal: "12100.00", difference: "-100.00", isReconciled: false });

      await expect(WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id)).rejects.toThrow(/does not agree to the ledger \(difference -100\.00\)/);
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id, { acknowledgeDifference: true });
      const audit = await withUserScope(w.partner.id, (tx) => tx.select().from(practiceAuditLogs).where(eq(practiceAuditLogs.action, "workpaper.preparer_signed")));
      expect(audit[0]!.metadata).toMatchObject({ difference: "-100.00", differenceAcknowledged: true });
    });

    it("rejects malformed amounts and over-long schedules", async () => {
      const { id } = await create();
      await expect(WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, [{ kind: "RECONCILING_ITEM", description: "x", amount: "12e3" }])).rejects.toThrow(/valid amount/);
      await expect(WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, [{ kind: "RECONCILING_ITEM", description: " ", amount: "1" }])).rejects.toThrow(/description/);
    });
  });

  describe("stale snapshot warning", () => {
    it("when the ledger moves after the snapshot (a late posting inside the period) the view says so, exactly; a refresh pulls a new snapshot and keeps the history", async () => {
      const { id } = await create();
      await PostingService.postJournal(owner(), {
        postingDate: D("2026-09-28"),
        memo: "Late posting",
        lines: [
          { accountId: bankId, debit: "150.25", currency: "AUD" },
          { accountId: revenueId, credit: "150.25", currency: "AUD" },
        ],
      });
      const stale = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(stale.freshness).toMatchObject({ checked: true, stale: true, currentBalance: "12150.2500", change: "150.25" });
      expect(stale.workpaper.ledgerBalance).toBe("12000.00"); // the snapshot itself is untouched until refreshed

      await WorkpaperService.refreshSnapshot(w.s1Actor, w.practiceId, id, new Date("2026-10-05T11:00:00Z"));
      const fresh = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(fresh.workpaper.ledgerBalance).toBe("12150.25");
      expect(fresh.freshness.stale).toBe(false);
      expect(fresh.snapshots.map((s) => s.ledgerBalance)).toEqual(["12000.00", "12150.25"]);
    });

    it("the freshness check is ONE single-account read: it opens exactly one tenant transaction for the client plus none else", async () => {
      const { id } = await create();
      tracker.reset();
      await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      // consent check + the one account balance query = two short sequential tenant transactions, never parallel.
      expect(tracker.tenantCalls).toEqual([A(), A()]);
      expect(tracker.maxActive).toBe(1);
    });
  });

  describe("evidence", () => {
    it("attaches evidence through the document store's validation, held by the PRACTICE (never in the client's receipt store)", async () => {
      const { id } = await create();
      await WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, { ...PDF, description: "September statement" });
      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.evidence).toMatchObject([{ fileName: "statement.pdf", mimeType: "application/pdf", fileSize: PDF.data.byteLength, description: "September statement", uploadedByName: "StaffOne" }]);
      const file = await WorkpaperService.getEvidenceFile(w.s2Actor, w.practiceId, d.evidence[0]!.id);
      expect(file!.data.equals(PDF.data)).toBe(true);
      expect((await withTenant(A(), (tx) => tx.select().from(uploadedReceipts))).length).toBe(0);

      await expect(WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, { fileName: "x.exe", mimeType: "application/x-msdownload", data: Buffer.from("MZ") })).rejects.toBeInstanceOf(UnsupportedDocumentFileTypeError);
      await expect(WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, { fileName: "big.pdf", mimeType: "application/pdf", data: Buffer.alloc(10 * 1024 * 1024 + 1) })).rejects.toBeInstanceOf(DocumentFileTooLargeError);
      await expect(WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, { fileName: "e.pdf", mimeType: "application/pdf", data: Buffer.alloc(0) })).rejects.toThrow(/empty/i);
      // Another practice's / a stranger's access: nothing.
      expect(await WorkpaperService.getEvidenceFile(w.s1Actor, w.practiceId, "00000000-0000-0000-0000-000000000000")).toBeNull();
      expect(await withUserScope(w.outsider.id, (tx) => tx.select().from(workpaperEvidence))).toEqual([]);
    });

    it("evidence can be removed while the paper is open, and never after sign-off", async () => {
      const { id } = await create();
      await WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, PDF);
      const [e] = (await WorkpaperService.get(w.s1Actor, w.practiceId, id)).evidence;
      await WorkpaperService.removeEvidence(w.s1Actor, w.practiceId, id, e!.id);
      expect((await WorkpaperService.get(w.s1Actor, w.practiceId, id)).evidence).toEqual([]);
    });
  });

  describe("adjustments are notes, never postings", () => {
    it("records a proposed adjustment and marks it posted by reference — without writing anything to the client's ledger", async () => {
      const { id } = await create();
      const before = await clientLedgerFingerprint();
      const adj = await WorkpaperService.proposeAdjustment(w.s1Actor, w.practiceId, id, { description: "Accrue bank fees", amount: "12.50", debitAccount: "6100 Bank fees", creditAccount: "1000 Bank" });
      await WorkpaperService.setAdjustmentStatus(w.s1Actor, w.practiceId, id, adj.id, "POSTED", "JE-000099");
      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.adjustments).toMatchObject([{ description: "Accrue bank fees", amount: "12.50", status: "POSTED", postedReference: "JE-000099" }]);
      expect(await clientLedgerFingerprint()).toEqual(before);
    });
  });

  describe("review notes, sign-off and segregation of duties (practice: partner + S1 + S2)", () => {
    it("full lifecycle: preparer signs, a note blocks the reviewer until resolved, the preparer cannot review their own work, a colleague signs it off", async () => {
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, reconcilingSchedule);
      await WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, PDF);

      // Only the preparer may sign as preparer; the reviewer step needs the preparer first.
      await expect(WorkpaperService.signAsPreparer(w.s2Actor, w.practiceId, id)).rejects.toBeInstanceOf(SignoffRuleError);
      await expect(WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id)).rejects.toBeInstanceOf(WorkpaperStateError);
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id);
      expect((await WorkpaperService.get(w.s1Actor, w.practiceId, id)).workpaper.status).toBe("IN_REVIEW");

      // Segregation: the preparer cannot also review (the practice has three active staff).
      await expect(WorkpaperService.signAsReviewer(w.s1Actor, w.practiceId, id)).rejects.toThrow(/different person from the preparer/);

      // A reviewer's note blocks sign-off until it is resolved (and stays in the history).
      const note = await WorkpaperService.addReviewNote(w.s2Actor, w.practiceId, id, "Please attach the cheque register.");
      await expect(WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id)).rejects.toThrow(/1 review note is still open/);
      await WorkpaperService.resolveReviewNote(w.s1Actor, w.practiceId, id, note.id, "Attached to the evidence list.");
      await WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id);

      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.workpaper.status).toBe("SIGNED_OFF");
      expect(d.notes).toMatchObject([{ status: "RESOLVED", authorName: "StaffTwo", resolvedByName: "StaffOne", resolutionComment: "Attached to the evidence list.", body: "Please attach the cheque register." }]);
      expect(d.signoffs.map((s) => [s.step, s.userName, s.version, s.singleStaffException])).toEqual([["PREPARER", "StaffOne", 1, false], ["REVIEWER", "StaffTwo", 1, false]]);
    });

    it("a single-staff practice may sign both steps — flagged as the documented exception", async () => {
      const solo = await createTestUser("SoloAccountant");
      const soloActor = { userId: solo.id };
      const soloPractice = await PracticeService.create(soloActor, { name: "Solo Practice" });
      // The solo accountant owns the client org they link (they are its OWNER, so they can accept).
      const org = await OrganizationService.createWithOwner(solo.id, { slug: `solo-client-${Date.now()}`, name: "Solo Client", baseCurrency: "AUD" });
      const soloOwner = { userId: solo.id, organizationId: org.id, role: "OWNER" as const };
      const cash = await AccountService.create(soloOwner, { code: "1000", name: "Cash", type: "ASSET", currency: "AUD" });
      const eq2 = await AccountService.create(soloOwner, { code: "3100", name: "Capital", type: "EQUITY", currency: "AUD" });
      await PostingService.postJournal(soloOwner, { postingDate: D("2026-09-01"), lines: [{ accountId: cash.id, debit: "100.00", currency: "AUD" }, { accountId: eq2.id, credit: "100.00", currency: "AUD" }] });
      await ClientLinkService.propose(soloActor, soloPractice.id, org.slug);
      const [consent] = await PracticeConsentService.list(soloOwner);
      await PracticeConsentService.accept(soloOwner, consent!.id);
      await ClientLinkService.verify(soloActor, soloPractice.id, [org.id]); // the practice observes the acceptance

      const { id } = await WorkpaperService.create(soloActor, soloPractice.id, { clientOrganizationId: org.id, accountId: cash.id, periodEnd: "2026-09-30" }, NOW);
      await WorkpaperService.setSchedule(soloActor, soloPractice.id, id, [{ kind: "SUPPORTING_BALANCE", description: "Count", amount: "100.00" }]);
      await WorkpaperService.signAsPreparer(soloActor, soloPractice.id, id);
      await WorkpaperService.signAsReviewer(soloActor, soloPractice.id, id);
      const d = await WorkpaperService.get(soloActor, soloPractice.id, id);
      expect(d.workpaper.status).toBe("SIGNED_OFF");
      expect(d.signoffs.find((s) => s.step === "REVIEWER")!.singleStaffException).toBe(true);
      const audit = await withUserScope(solo.id, (tx) => tx.select().from(practiceAuditLogs).where(eq(practiceAuditLogs.action, "workpaper.reviewer_signed")));
      expect(audit[0]!.metadata).toMatchObject({ singleStaffException: true });

      // The moment a second person joins, the exception is gone for the next workpaper.
      await PracticeService.addStaffByEmail(soloActor, soloPractice.id, w.s1.email, "STAFF");
      await WorkpaperService.reopen(soloActor, soloPractice.id, id, "Correcting the count");
      await WorkpaperService.signAsPreparer(soloActor, soloPractice.id, id);
      await expect(WorkpaperService.signAsReviewer(soloActor, soloPractice.id, id)).rejects.toThrow(/different person/);
    });
  });

  describe("immutability once SIGNED_OFF, and reopening with a reason", () => {
    const signedOff = async () => {
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, reconcilingSchedule);
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id);
      await WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id);
      return id;
    };

    it("the service refuses every change to a signed-off paper", async () => {
      const id = await signedOff();
      const state = WorkpaperStateError;
      await expect(WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, reconcilingSchedule)).rejects.toBeInstanceOf(state);
      await expect(WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, PDF)).rejects.toBeInstanceOf(state);
      await expect(WorkpaperService.addReviewNote(w.s2Actor, w.practiceId, id, "too late")).rejects.toBeInstanceOf(state);
      await expect(WorkpaperService.proposeAdjustment(w.s1Actor, w.practiceId, id, { description: "x", amount: "1" })).rejects.toBeInstanceOf(state);
      await expect(WorkpaperService.refreshSnapshot(w.s1Actor, w.practiceId, id)).rejects.toBeInstanceOf(state);
    });

    it("the DATABASE refuses them too, even called directly with the real restricted role (RLS frozen-state predicate + append-only grants)", async () => {
      const id = await signedOff();
      const row = (await withUserScope(w.s1.id, (tx) => tx.select().from(workpapers).where(eq(workpapers.id, id))))[0]!;
      const common = { workpaperId: id, practiceId: w.practiceId };
      expect(await pgMessage(withUserScope(w.s1.id, (tx) => tx.insert(workpaperScheduleLines).values({ ...common, lineNumber: 99, kind: "RECONCILING_ITEM", description: "sneaky", amount: "1" })))).toMatch(/row-level security/i);
      expect(await pgMessage(withUserScope(w.s1.id, (tx) => tx.update(workpaperScheduleLines).set({ amount: "999999" }).where(eq(workpaperScheduleLines.workpaperId, id)).returning()))).toBe(""); // zero rows visible to update
      const lines = await withUserScope(w.s1.id, (tx) => tx.select().from(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, id)));
      expect(lines.map((l) => l.amount)).toEqual(["12450.0000", "-450.0000"]); // untouched
      expect(await pgMessage(withUserScope(w.s1.id, (tx) => tx.delete(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, id))))).toBe("");
      expect((await withUserScope(w.s1.id, (tx) => tx.select().from(workpaperScheduleLines).where(eq(workpaperScheduleLines.workpaperId, id)))).length).toBe(2);
      expect(await pgMessage(withUserScope(w.s1.id, (tx) => tx.insert(workpaperEvidence).values({ ...common, fileName: "x.pdf", mimeType: "application/pdf", fileSize: 1, fileData: Buffer.from("x"), uploadedByUserId: w.s1.id })))).toMatch(/row-level security/i);
      expect(await pgMessage(withUserScope(w.s2.id, (tx) => tx.insert(workpaperReviewNotes).values({ ...common, version: row.version, body: "late", authorUserId: w.s2.id })))).toMatch(/row-level security/i);
      expect(await pgMessage(withUserScope(w.s1.id, (tx) => tx.insert(workpaperAdjustments).values({ ...common, description: "late", amount: "1", createdByUserId: w.s1.id })))).toMatch(/row-level security/i);
    });

    it("sign-offs, snapshots and review-note text are append-only / immutable for the real application role", async () => {
      const id = await signedOff();
      await WorkpaperService.reopen(w.partnerActor, w.practiceId, id, "Correcting a cheque number");
      const note = await WorkpaperService.addReviewNote(w.s2Actor, w.practiceId, id, "Check chq 1043");
      expect(await pgMessage(withUserScope(w.partner.id, (tx) => tx.update(workpaperSignoffs).set({ reason: "rewritten" }).where(eq(workpaperSignoffs.workpaperId, id))))).toMatch(/permission denied/i);
      expect(await pgMessage(withUserScope(w.partner.id, (tx) => tx.delete(workpaperSignoffs).where(eq(workpaperSignoffs.workpaperId, id))))).toMatch(/permission denied/i);
      expect(await pgMessage(withUserScope(w.partner.id, (tx) => tx.update(workpaperSnapshots).set({ ledgerBalance: "1" }).where(eq(workpaperSnapshots.workpaperId, id))))).toMatch(/permission denied/i);
      expect(await pgMessage(withUserScope(w.partner.id, (tx) => tx.delete(workpaperSnapshots).where(eq(workpaperSnapshots.workpaperId, id))))).toMatch(/permission denied/i);
      // A note's TEXT cannot be rewritten (column-level grant covers only the resolution fields) and a note is never deleted.
      expect(await pgMessage(withUserScope(w.s2.id, (tx) => tx.update(workpaperReviewNotes).set({ body: "rewritten" }).where(eq(workpaperReviewNotes.id, note.id))))).toMatch(/permission denied/i);
      expect(await pgMessage(withUserScope(w.s2.id, (tx) => tx.delete(workpaperReviewNotes).where(eq(workpaperReviewNotes.id, note.id))))).toMatch(/permission denied/i);
    });

    it("reopening needs a reason, MANAGER+ for a signed-off paper, bumps the version and keeps the whole history", async () => {
      const id = await signedOff();
      await expect(WorkpaperService.reopen(w.partnerActor, w.practiceId, id, "  ")).rejects.toThrow(/reason/);
      await expect(WorkpaperService.reopen(w.s1Actor, w.practiceId, id, "I want to change it")).rejects.toBeInstanceOf(PracticePermissionError);
      expect((await WorkpaperService.reopen(w.partnerActor, w.practiceId, id, "Statement balance was mistyped")).version).toBe(2);

      let d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.workpaper).toMatchObject({ status: "DRAFT", version: 2 });
      expect(d.signoffs.map((s) => [s.step, s.version, s.reason])).toEqual([["PREPARER", 1, null], ["REVIEWER", 1, null], ["REOPEN", 2, "Statement balance was mistyped"]]);

      // Edit, then sign again at version 2: the earlier sign-offs are history, not a shortcut.
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, [{ ...reconcilingSchedule[0]!, amount: "12450.00" }, reconcilingSchedule[1]!]);
      await expect(WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id)).rejects.toBeInstanceOf(WorkpaperStateError);
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id);
      await WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id);
      d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(d.signoffs.length).toBe(5);
      expect(d.signoffs.at(-1)).toMatchObject({ step: "REVIEWER", version: 2 });
    });

    it("a paper in review can be returned to draft by any member with a reason (same version)", async () => {
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, reconcilingSchedule);
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id);
      expect((await WorkpaperService.reopen(w.s2Actor, w.practiceId, id, "Needs another look")).version).toBe(1);
      expect((await WorkpaperService.get(w.s1Actor, w.practiceId, id)).workpaper.status).toBe("DRAFT");
    });
  });

  describe("carry-forward", () => {
    it("creates the next period's workpaper from a signed-off one: structure + recurring lines + comparative; never evidence, sign-offs, notes or adjustments", async () => {
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, [...reconcilingSchedule, { kind: "RECONCILING_ITEM", description: "Monthly bank fee accrual", amount: "-12.50", isRecurring: true }]);
      await WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, PDF);
      await WorkpaperService.proposeAdjustment(w.s1Actor, w.practiceId, id, { description: "x", amount: "1" });
      const note = await WorkpaperService.addReviewNote(w.s2Actor, w.practiceId, id, "ok?");
      await WorkpaperService.resolveReviewNote(w.s2Actor, w.practiceId, id, note.id);
      await expect(WorkpaperService.carryForward(w.s1Actor, w.practiceId, id, {}, NOW)).rejects.toBeInstanceOf(WorkpaperStateError); // not signed off yet
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id, { acknowledgeDifference: true });
      await WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id, { acknowledgeDifference: true });

      const next = await WorkpaperService.carryForward(w.s1Actor, w.practiceId, id, {}, new Date("2026-11-02T09:00:00Z"));
      expect(next.disposition.map((x) => x.outcome)).toEqual(["STRUCTURE_ONLY_ZEROED", "DROPPED", "COPIED_RECURRING"]);

      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, next.id);
      expect(d.workpaper).toMatchObject({ periodEnd: "2026-10-31", status: "DRAFT", version: 1, ledgerBalance: "12500.00", priorPeriodEnd: "2026-09-30", priorLedgerBalance: "12000.00", priorWorkpaperId: id });
      expect(d.lines.map((l) => [l.kind, l.description, l.amount])).toEqual([
        ["SUPPORTING_BALANCE", "Bank statement balance", "0.00"],
        ["RECONCILING_ITEM", "Monthly bank fee accrual", "-12.50"],
      ]);
      expect(d.evidence).toEqual([]);
      expect(d.adjustments).toEqual([]);
      expect(d.notes).toEqual([]);
      expect(d.signoffs).toEqual([]);
      expect(d.snapshots.length).toBe(1);
      // October's balance is a FRESH pull (12,000 + the 500.00 October sale), with the prior balance only as the comparative.
      expect(d.snapshots[0]!.ledgerBalance).toBe("12500.00");
      // The source is untouched.
      expect((await WorkpaperService.get(w.s1Actor, w.practiceId, id)).workpaper.status).toBe("SIGNED_OFF");
      await expect(WorkpaperService.carryForward(w.s1Actor, w.practiceId, id, { periodEnd: "2026-10-31" }, NOW)).rejects.toBeInstanceOf(DuplicateWorkpaperError);
      await expect(WorkpaperService.carryForward(w.s1Actor, w.practiceId, id, { periodEnd: "2026-08-31" }, NOW)).rejects.toThrow(/must end after/);
    });
  });

  describe("the client's ledger is never written", () => {
    it("journal entries, lines, the trial balance and the audit-log ids of the client are byte-identical before and after a full workpaper lifecycle", async () => {
      const before = await clientLedgerFingerprint();
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, reconcilingSchedule);
      await WorkpaperService.addEvidence(w.s1Actor, w.practiceId, id, PDF);
      await WorkpaperService.proposeAdjustment(w.s1Actor, w.practiceId, id, { description: "Accrue fees", amount: "12.50" });
      await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      await WorkpaperService.refreshSnapshot(w.s1Actor, w.practiceId, id, NOW);
      const note = await WorkpaperService.addReviewNote(w.s2Actor, w.practiceId, id, "fine");
      await WorkpaperService.resolveReviewNote(w.s2Actor, w.practiceId, id, note.id);
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id);
      await WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id);
      await WorkpaperService.reopen(w.partnerActor, w.practiceId, id, "Re-check the statement");
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id);
      await WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id);
      await WorkpaperService.carryForward(w.s1Actor, w.practiceId, id, {}, NOW);
      expect(await clientLedgerFingerprint()).toEqual(before);
    });
  });

  describe("practice-owned, retained after the client revokes access", () => {
    it("the paper stays readable and editable as of its snapshot date, clearly marked; nothing live is read and nothing new can be pulled", async () => {
      const { id } = await create();
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, id, reconcilingSchedule);
      await revokeConsent(w.clients.A, w.practiceId);
      await ClientLinkService.verify(w.partnerActor, w.practiceId, [A()]);

      tracker.reset();
      const d = await WorkpaperService.get(w.s1Actor, w.practiceId, id);
      expect(tracker.tenantCalls).toEqual([]); // no client read at all
      expect(d.retentionNote).toMatch(/ended this practice's access \(revoked\)/);
      expect(d.retentionNote).toContain("retained by your practice as a record as of 2026-10-05");
      expect(d.freshness).toMatchObject({ checked: false, stale: false });
      expect(d.workpaper).toMatchObject({ ledgerBalance: "12000.00", linkStatus: "REVOKED" });
      expect(d.reconciliation.isReconciled).toBe(true);

      await expect(WorkpaperService.refreshSnapshot(w.s1Actor, w.practiceId, id)).rejects.toBeInstanceOf(LinkNotActiveError);
      await expect(create("2026-08-31")).rejects.toBeInstanceOf(LinkNotActiveError);
      // The practice can still finish its own review of the retained record.
      await WorkpaperService.signAsPreparer(w.s1Actor, w.practiceId, id);
      await WorkpaperService.signAsReviewer(w.s2Actor, w.practiceId, id);
      expect((await WorkpaperService.get(w.s1Actor, w.practiceId, id)).workpaper.status).toBe("SIGNED_OFF");
    });
  });

  describe("who can see a workpaper", () => {
    it("only active practice members: an outsider and a removed member can neither read nor list it", async () => {
      const { id } = await create();
      await expect(WorkpaperService.get(w.outsiderActor, w.practiceId, id)).rejects.toThrow(/does not exist/);
      await expect(WorkpaperService.list(w.outsiderActor, w.practiceId)).rejects.toThrow(/does not exist/);
      expect(await withUserScope(w.outsider.id, async (tx) => ({
        wp: await tx.select().from(workpapers),
        lines: await tx.select().from(workpaperScheduleLines),
        snaps: await tx.select().from(workpaperSnapshots),
        notes: await tx.select().from(workpaperReviewNotes),
        signoffs: await tx.select().from(workpaperSignoffs),
        adj: await tx.select().from(workpaperAdjustments),
      }))).toEqual({ wp: [], lines: [], snaps: [], notes: [], signoffs: [], adj: [] });

      await PracticeService.removeStaff(w.partnerActor, w.practiceId, w.s2.id);
      await expect(WorkpaperService.get(w.s2Actor, w.practiceId, id)).rejects.toThrow(/does not exist/);
      await expect(WorkpaperService.get(w.s1Actor, w.practiceId, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(WorkpaperNotFoundError);
      expect((await WorkpaperService.list(w.s1Actor, w.practiceId)).map((x) => x.id)).toEqual([id]);
    });

    it("a staff member with no access to the client's books can still read the retained paper but cannot pull or refresh figures", async () => {
      const { id } = await create();
      // S2 is not a member of A: they see the paper (a practice record) but the live check reports why it could not run.
      const d = await WorkpaperService.get(w.s2Actor, w.practiceId, id);
      expect(d.workpaper.ledgerBalance).toBe("12000.00");
      expect(d.freshness.checked).toBe(false);
      expect(d.freshness.reason).toMatch(/not a member of/);
      await expect(WorkpaperService.refreshSnapshot(w.s2Actor, w.practiceId, id)).rejects.toThrow(/not a member of/);
      await expect(WorkpaperService.create(w.s2Actor, w.practiceId, { clientOrganizationId: A(), accountId: bankId, periodEnd: "2026-08-31" }, NOW)).rejects.toThrow(/not a member of/);
      expect(PermissionDeniedError).toBeDefined();
    });
  });

  // -------------------------------------------------------------------- helpers
  async function clientLedgerFingerprint() {
    const base = await withTenant(A(), async (tx) => {
      const entries = await tx.select({ id: journalEntries.id, n: journalEntries.entryNumber, status: journalEntries.status }).from(journalEntries).orderBy(journalEntries.entryNumber);
      const lines = await tx.select({ id: journalLines.id, a: journalLines.accountId, d: journalLines.debit, c: journalLines.credit }).from(journalLines).orderBy(journalLines.id);
      const audit = await tx.select({ id: auditLogs.id }).from(auditLogs).orderBy(auditLogs.id);
      return { entries, lines, auditIds: audit.map((x) => x.id) };
    });
    return { ...base, trialBalance: await LedgerService.getTrialBalance(owner(), D("2026-12-31")) };
  }
});
