import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSampleAccounts } from "../../helpers/ledger";
import { withTenant } from "@/db/tenant";
import { journalEntries, periodLockEvents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { PostingService } from "@/domain/ledger/posting-service";
import { FiscalPeriodService } from "@/domain/ledger/fiscal-period-service";
import { PeriodLockedError } from "@/domain/ledger/errors";
import { PeriodLockService } from "@/domain/close/period-lock-service";
import { LOCK_LEVELS, type LockLevel } from "@/domain/ledger/period-lock";
import type { Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole } from "@/domain/permissions/roles";

const REASON = "Late supplier invoice arrived after the soft lock";

describe("Posting under each period lock level (Phase 9 Slice 3)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;
  let bank: string;
  let revenue: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("period-lock");
    owner = org.owner;
    orgId = org.organizationId;
    const ids = await createSampleAccounts(owner, org.baseCurrency);
    bank = ids[0]!;
    revenue = ids[4]!;
  });

  const draft = (date: string, amount = "10.00") => ({
    postingDate: new Date(date),
    memo: "test",
    lines: [
      { accountId: bank, debit: amount, currency: "AUD" },
      { accountId: revenue, credit: amount, currency: "AUD" },
    ],
  });

  async function counts() {
    return withTenant(orgId, async (tx) => {
      const res = await tx.execute(sql`
        select
          (select count(*)::int from journal_entries) as entries,
          (select count(*)::int from journal_lines) as lines,
          (select count(*)::int from audit_logs) as audits,
          (select count(*)::int from period_lock_events) as events`);
      return (res as unknown as { rows: Array<Record<string, number>> }).rows[0]!;
    });
  }

  async function periodAt(level: LockLevel, label = "2026-07", start = "2026-07-01", end = "2026-07-31") {
    const period = await FiscalPeriodService.create(owner, { label, startDate: new Date(start), endDate: new Date(end) });
    if (level !== "OPEN") await PeriodLockService.raise(owner, { kind: "id", id: period.id }, level);
    return period;
  }

  const POSTING_ROLES: MembershipRole[] = ["OWNER", "ADMINISTRATOR", "ACCOUNTANT", "BOOKKEEPER"];

  // role -> expected outcome of an inline post WITHOUT a reason, per level.
  const EXPECT_NO_REASON: Record<LockLevel, Record<string, "ok" | "reject">> = {
    OPEN: { OWNER: "ok", ADMINISTRATOR: "ok", ACCOUNTANT: "ok", BOOKKEEPER: "ok" },
    SOFT_LOCKED: { OWNER: "reject", ADMINISTRATOR: "reject", ACCOUNTANT: "reject", BOOKKEEPER: "reject" },
    ADVISOR_LOCKED: { OWNER: "ok", ADMINISTRATOR: "ok", ACCOUNTANT: "ok", BOOKKEEPER: "reject" },
    TAX_LOCKED: { OWNER: "reject", ADMINISTRATOR: "reject", ACCOUNTANT: "reject", BOOKKEEPER: "reject" },
    HARD_LOCKED: { OWNER: "reject", ADMINISTRATOR: "reject", ACCOUNTANT: "reject", BOOKKEEPER: "reject" },
  };

  for (const level of LOCK_LEVELS) {
    it(`${level}: each posting role gets the right outcome, and a rejected post leaves NOTHING behind`, async () => {
      await periodAt(level);
      for (const role of POSTING_ROLES) {
        const actor = actorWithRole(owner, role);
        const before = await counts();
        const attempt = PostingService.postJournal(actor, draft("2026-07-15"));
        if (EXPECT_NO_REASON[level][role] === "ok") {
          await expect(attempt, `${level}/${role}`).resolves.toBeDefined();
          const after = await counts();
          expect(after.entries).toBe(before.entries! + 1);
        } else {
          const error = await attempt.then(
            () => null,
            (e: unknown) => e,
          );
          expect(error, `${level}/${role}`).toBeInstanceOf(PeriodLockedError);
          expect((error as PeriodLockedError).lockLevel).toBe(level);
          // No journal entry, no lines, no audit entry, no lock event: the whole transaction rolled back.
          expect(await counts()).toEqual(before);
        }
      }
    });
  }

  it("SOFT_LOCKED + reason: an accountant-level role posts, the journal records the override, and history + audit entries are written", async () => {
    const period = await periodAt("SOFT_LOCKED");
    const accountant = actorWithRole(owner, "ACCOUNTANT");

    // Without a reason the rejection tells the UI an override is available.
    const refused = await PostingService.postJournal(accountant, draft("2026-07-15")).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(PeriodLockedError);
    expect((refused as PeriodLockedError).canOverrideWithReason).toBe(true);

    const result = await PostingService.postJournal(accountant, draft("2026-07-15"), { lockOverrideReason: REASON });
    await withTenant(orgId, async (tx) => {
      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, result.entryId));
      expect(entry).toMatchObject({ status: "POSTED", lockOverrideLevel: "SOFT_LOCKED", lockOverrideReason: REASON, fiscalPeriodId: period.id });
      const events = await tx.select().from(periodLockEvents).where(eq(periodLockEvents.journalEntryId, result.entryId));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: "POSTING_OVERRIDE", fromLevel: "SOFT_LOCKED", toLevel: "SOFT_LOCKED", reason: REASON, actorRole: "ACCOUNTANT", actorUserId: owner.userId });
      const audit = await tx.execute(sql`select action, after from audit_logs where entity_id = ${result.entryId} order by created_at`);
      const actions = (audit as unknown as { rows: Array<{ action: string; after: { reason?: string } }> }).rows;
      expect(actions.map((a) => a.action).sort()).toEqual(["journal.posted", "journal.posted_under_lock"]);
      expect(actions.find((a) => a.action === "journal.posted_under_lock")!.after.reason).toBe(REASON);
    });
  });

  it("a BOOKKEEPER cannot override a soft lock even by supplying a reason (the client reason is not the authority)", async () => {
    await periodAt("SOFT_LOCKED");
    const before = await counts();
    const error = await PostingService.postJournal(actorWithRole(owner, "BOOKKEEPER"), draft("2026-07-15"), { lockOverrideReason: REASON }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PeriodLockedError);
    expect((error as PeriodLockedError).canOverrideWithReason).toBe(false);
    expect((error as PeriodLockedError).message).toMatch(/Accountant, Administrator or Owner/);
    expect(await counts()).toEqual(before);
  });

  it("a too-short override reason is refused as if none was given", async () => {
    await periodAt("SOFT_LOCKED");
    await expect(PostingService.postJournal(owner, draft("2026-07-15"), { lockOverrideReason: "oops" })).rejects.toThrow(PeriodLockedError);
  });

  it("an AI actor can never post under a lock, even one holding an OWNER role", async () => {
    await periodAt("SOFT_LOCKED");
    const ai: Actor = { ...owner, type: "AI" };
    await expect(PostingService.postJournal(ai, draft("2026-07-15"), { lockOverrideReason: REASON })).rejects.toThrow(PeriodLockedError);
  });

  it("HARD_LOCKED rejects even the OWNER inline, with a reason", async () => {
    await periodAt("HARD_LOCKED");
    const before = await counts();
    await expect(PostingService.postJournal(owner, draft("2026-07-15"), { lockOverrideReason: REASON })).rejects.toThrow(/no one can post/i);
    expect(await counts()).toEqual(before);
  });

  it("TAX_LOCKED rejects every role inline and the message points at the reopen workflow and the lodgement", async () => {
    await periodAt("TAX_LOCKED");
    const err = await PostingService.postJournal(owner, draft("2026-07-15"), { lockOverrideReason: REASON }).then(() => null, (e: unknown) => e);
    expect((err as PeriodLockedError).message).toMatch(/lodge/i);
    expect((err as PeriodLockedError).message).toMatch(/Owner or Administrator/);
  });

  it("ADVISOR_LOCKED: an accountant posts and the entry is marked as posted under the advisor lock; a bookkeeper is refused", async () => {
    await periodAt("ADVISOR_LOCKED");
    const ok = await PostingService.postJournal(actorWithRole(owner, "ACCOUNTANT"), draft("2026-07-15"));
    await withTenant(orgId, async (tx) => {
      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, ok.entryId));
      expect(entry).toMatchObject({ lockOverrideLevel: "ADVISOR_LOCKED", lockOverrideReason: null });
    });
    await expect(PostingService.postJournal(actorWithRole(owner, "BOOKKEEPER"), draft("2026-07-15"))).rejects.toThrow(PeriodLockedError);
  });

  it("a DRAFT can still be saved into a locked period, but posting it is subject to the lock — with the same override path", async () => {
    await periodAt("SOFT_LOCKED");
    const d = await PostingService.createDraft(actorWithRole(owner, "BOOKKEEPER"), draft("2026-07-15"));
    await expect(PostingService.postDraft(actorWithRole(owner, "BOOKKEEPER"), d.entryId)).rejects.toThrow(PeriodLockedError);
    await expect(PostingService.postDraft(owner, d.entryId)).rejects.toThrow(PeriodLockedError); // owner without a reason
    await PostingService.postDraft(owner, d.entryId, { lockOverrideReason: REASON });
    await withTenant(orgId, async (tx) => {
      const [entry] = await tx.select().from(journalEntries).where(eq(journalEntries.id, d.entryId));
      expect(entry).toMatchObject({ status: "POSTED", lockOverrideLevel: "SOFT_LOCKED", lockOverrideReason: REASON });
    });
  });

  it("corrections never edit history: reversing an entry in a locked period lands the reversal in an open period and leaves the original lines untouched", async () => {
    const period = await periodAt("OPEN");
    const posted = await PostingService.postJournal(owner, draft("2026-07-15", "50.00"));
    await PeriodLockService.raise(owner, { kind: "id", id: period.id }, "HARD_LOCKED");

    const reversal = await PostingService.reverseEntry(owner, posted.entryId, "Wrong amount");
    await withTenant(orgId, async (tx) => {
      const [orig] = await tx.select().from(journalEntries).where(eq(journalEntries.id, posted.entryId));
      const [rev] = await tx.select().from(journalEntries).where(eq(journalEntries.id, reversal.entryId));
      expect(orig!.postingDate.toISOString()).toBe("2026-07-15T00:00:00.000Z");
      expect(orig!.status).toBe("REVERSED");
      expect(rev!.reversalOfId).toBe(posted.entryId);
      expect(rev!.postingDate.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
    });

    // A reversal dated INTO the hard-locked period is refused.
    const other = await PostingService.postJournal(owner, draft("2026-08-15", "5.00"));
    const before = await counts();
    await expect(PostingService.reverseEntry(owner, other.entryId, "Backdate", new Date("2026-07-20"))).rejects.toThrow(PeriodLockedError);
    expect(await counts()).toEqual(before);
  });

  it("overlapping periods: the most restrictive covering period governs (a hard-locked month inside an open year)", async () => {
    await FiscalPeriodService.create(owner, { label: "FY2027", startDate: new Date("2026-07-01"), endDate: new Date("2027-06-30") });
    await periodAt("HARD_LOCKED", "2026-09", "2026-09-01", "2026-09-30");
    await expect(PostingService.postJournal(owner, draft("2026-09-10"))).rejects.toThrow(PeriodLockedError);
    await expect(PostingService.postJournal(owner, draft("2026-10-10"))).resolves.toBeDefined();
  });

  it("the period end date covers its WHOLE day: a timestamped posting on the last day cannot slip past the lock", async () => {
    await periodAt("HARD_LOCKED");
    await expect(PostingService.postJournal(owner, draft("2026-07-31T15:30:00Z"))).rejects.toThrow(PeriodLockedError);
    // ...while the next day is outside it.
    await expect(PostingService.postJournal(owner, draft("2026-08-01T00:00:00Z"))).resolves.toBeDefined();
  });

  it("dates with no period at all still post (periods are explicit, never required)", async () => {
    await expect(PostingService.postJournal(owner, draft("2031-01-01"))).resolves.toBeDefined();
  });

  it("legacy FiscalPeriodService.setStatus is routed through the new model: raising works, lowering needs reopen permission and a reason", async () => {
    const period = await FiscalPeriodService.create(owner, { label: "L1", startDate: new Date("2026-03-01"), endDate: new Date("2026-03-31") });
    await FiscalPeriodService.setStatus(owner, period.id, "HARD_LOCKED", "Year closed");
    // An accountant holds fiscal_period:manage but may not reopen a HARD lock.
    await expect(FiscalPeriodService.setStatus(actorWithRole(owner, "ACCOUNTANT"), period.id, "OPEN", REASON)).rejects.toThrow(/period:reopen_hard/);
    // No reason, no reopen.
    await expect(FiscalPeriodService.setStatus(owner, period.id, "OPEN")).rejects.toThrow(/reason/i);
    const reopened = await FiscalPeriodService.setStatus(owner, period.id, "OPEN", REASON);
    expect(reopened!.status).toBe("OPEN");
  });
});
