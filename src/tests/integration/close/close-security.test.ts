import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { D, seedCloseScenario } from "../../helpers/close";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { closeSignoffs, fiscalPeriods, periodCloses, periodLockEvents } from "@/db/schema";
import { PeriodCloseService } from "@/domain/close/period-close-service";
import { PeriodLockService } from "@/domain/close/period-lock-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { PeriodLockedError } from "@/domain/ledger/errors";
import type { Actor } from "@/domain/permissions/permission-service";

async function pgMessage(promise: PromiseLike<unknown>): Promise<string> {
  const error = await Promise.resolve(promise).then(
    () => null,
    (e: { message: string; cause?: { message?: string } }) => e,
  );
  expect(error, "the statement must be refused").not.toBeNull();
  return error!.cause?.message ?? error!.message;
}

describe("Close / lock tables — database-level guarantees (Phase 9 Slice 3)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let orgA: Awaited<ReturnType<typeof createTestOrg>>;
  let orgB: Awaited<ReturnType<typeof createTestOrg>>;
  let owner: Actor;

  beforeEach(async () => {
    await resetDatabase();
    orgA = await createTestOrg("close-sec-a");
    orgB = await createTestOrg("close-sec-b");
    owner = orgA.owner;
    await seedCloseScenario(owner, orgA.baseCurrency);
    await PeriodCloseService.signOff(owner, "2026-09", "manual.accruals", "reviewed");
    await PeriodCloseService.close(owner, "2026-09", { acknowledgeOutstanding: true });
  });

  it("mm_app is the real restricted role, and may only INSERT and SELECT the lock history: UPDATE, DELETE and TRUNCATE are refused by Postgres", async () => {
    const who = await db.execute(sql`SELECT current_user AS u, (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS privileged`);
    expect((who.rows[0] as { u: string }).u).toBe("mm_app");
    expect((who.rows[0] as { privileged: boolean }).privileged).toBe(false);

    const count = await withTenant(orgA.organizationId, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM period_lock_events`));
    expect((count.rows[0] as { n: number }).n).toBeGreaterThan(0); // SELECT works (and INSERT did, via the close)

    // Even with the correct tenant context (so RLS would allow the row), the statements are refused outright.
    for (const statement of [
      sql`UPDATE period_lock_events SET reason = 'tampered'`,
      sql`DELETE FROM period_lock_events`,
      sql`TRUNCATE period_lock_events`,
    ]) {
      expect(await pgMessage(withTenant(orgA.organizationId, (tx) => tx.execute(statement)))).toMatch(/permission denied/i);
      expect(await pgMessage(db.execute(statement))).toMatch(/permission denied/i);
    }
    // The row is untouched.
    const after = await withTenant(orgA.organizationId, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM period_lock_events WHERE reason = 'tampered'`));
    expect((after.rows[0] as { n: number }).n).toBe(0);
  });

  it("sign-offs can be created/revoked but never edited; close cycles can be updated but never deleted", async () => {
    expect(await pgMessage(withTenant(orgA.organizationId, (tx) => tx.execute(sql`UPDATE close_signoffs SET note = 'edited'`)))).toMatch(/permission denied/i);
    expect(await pgMessage(withTenant(orgA.organizationId, (tx) => tx.execute(sql`DELETE FROM period_closes`)))).toMatch(/permission denied/i);
    expect(await pgMessage(db.execute(sql`TRUNCATE close_signoffs`))).toMatch(/permission denied/i);
    expect(await pgMessage(db.execute(sql`TRUNCATE period_closes`))).toMatch(/permission denied/i);
  });

  it("tenant isolation: org A's close cycle, sign-off, lock events and period are invisible to org B, even by direct query with no filter", async () => {
    for (const table of [periodCloses, closeSignoffs, periodLockEvents, fiscalPeriods]) {
      const asA = await withTenant(orgA.organizationId, (tx) => tx.select().from(table));
      expect(asA.length).toBeGreaterThan(0);
      expect(await withTenant(orgB.organizationId, (tx) => tx.select().from(table))).toHaveLength(0);
      // No tenant context at all: nothing.
      expect(await db.select().from(table)).toHaveLength(0);
    }

    // Org B cannot see or change A's period through the service layer either…
    const bOwner = orgB.owner;
    const workspace = await PeriodCloseService.getWorkspace(bOwner, "2026-09");
    expect(workspace.cycles).toEqual([]);
    expect(workspace.events).toEqual([]);
    expect(workspace.checklist.period.lockLevel).toBe("OPEN");
    await expect(PeriodLockService.reopen(bOwner, "2026-09", { reason: "Trying to reopen another org's period" })).rejects.toThrow(/never been locked/);

    // …and cannot forge a row for A: the RLS WITH CHECK refuses an insert for another tenant.
    const [aPeriod] = await withTenant(orgA.organizationId, (tx) => tx.select().from(fiscalPeriods));
    const forged = withTenant(orgB.organizationId, (tx) =>
      tx.insert(periodLockEvents).values({
        organizationId: orgA.organizationId,
        fiscalPeriodId: aPeriod!.id,
        eventType: "REOPENED",
        fromLevel: "HARD_LOCKED",
        toLevel: "OPEN",
        reason: "forged history entry",
      }),
    );
    expect(await pgMessage(forged)).toMatch(/row-level security|violates/i);
    // Org A's period is still locked, and org B's identical month key is independent of it.
    const bAccounts = await (await import("../../helpers/ledger")).createSampleAccounts(bOwner, "AUD");
    await expect(
      PostingService.postJournal(bOwner, {
        postingDate: D("2026-09-20"),
        lines: [{ accountId: bAccounts[0]!, debit: "1.00", currency: "AUD" }, { accountId: bAccounts[4]!, credit: "1.00", currency: "AUD" }],
      }),
    ).resolves.toBeDefined();
  });

  it("the new tables are all RLS-enabled and FORCEd", async () => {
    const rows = await db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('period_closes','close_signoffs','period_lock_events')`);
    expect(rows.rows).toHaveLength(3);
    for (const r of rows.rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
  });
});

describe("Legacy lock migration (drizzle/0037) — no existing lock is loosened", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("maps legacy SOFT_LOCKED (which blocked everyone) to HARD_LOCKED, carries HARD_LOCKED over, leaves OPEN alone, and records MIGRATED history", async () => {
    const org = await createTestOrg("legacy-migration");
    const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
    try {
      const insert = async (label: string, start: string, end: string, status: string) => {
        const r = await admin.query(
          `INSERT INTO fiscal_periods (organization_id, label, start_date, end_date, status, lock_reason, locked_at)
           VALUES ($1, $2, $3, $4, $5::fiscal_period_status, $6, now()) RETURNING id`,
          [org.organizationId, label, start, end, status, `legacy ${status}`],
        );
        return r.rows[0].id as string;
      };
      const soft = await insert("LEG-SOFT", "2026-01-01", "2026-01-31", "SOFT_LOCKED");
      const hard = await insert("LEG-HARD", "2026-02-01", "2026-02-28", "HARD_LOCKED");
      const open = await insert("LEG-OPEN", "2026-03-01", "2026-03-31", "OPEN");

      // Run the migration's data-mapping statements verbatim (everything from the INSERT onwards).
      const file = readFileSync(path.join(process.cwd(), "drizzle/0037_close_slice3_row_level_security.sql"), "utf8");
      const mapping = file.slice(file.indexOf("INSERT INTO period_lock_events"));
      await admin.query(mapping);

      const periods = await admin.query("SELECT id, status FROM fiscal_periods ORDER BY label");
      const byId = new Map(periods.rows.map((r) => [r.id as string, r.status as string]));
      expect(byId.get(soft)).toBe("HARD_LOCKED");
      expect(byId.get(hard)).toBe("HARD_LOCKED");
      expect(byId.get(open)).toBe("OPEN");

      const events = await admin.query("SELECT fiscal_period_id, event_type, from_level, to_level, reason, metadata FROM period_lock_events ORDER BY created_at, from_level");
      expect(events.rows).toHaveLength(2);
      const softEvent = events.rows.find((e) => e.fiscal_period_id === soft)!;
      expect(softEvent).toMatchObject({ event_type: "MIGRATED", from_level: "SOFT_LOCKED", to_level: "HARD_LOCKED" });
      expect(softEvent.reason).toMatch(/no existing lock is loosened/);
      expect(softEvent.metadata).toMatchObject({ legacyStatus: "SOFT_LOCKED", legacyLockReason: "legacy SOFT_LOCKED" });
      expect(events.rows.find((e) => e.fiscal_period_id === hard)).toMatchObject({ from_level: "HARD_LOCKED", to_level: "HARD_LOCKED" });

      // Behaviour check: nobody — not even the owner with a reason — can post into the formerly soft-locked period.
      const accountIds = await (await import("../../helpers/ledger")).createSampleAccounts(org.owner, "AUD");
      const tryPost = (date: string) =>
        PostingService.postJournal(
          org.owner,
          { postingDate: new Date(date), lines: [{ accountId: accountIds[0]!, debit: "1.00", currency: "AUD" }, { accountId: accountIds[4]!, credit: "1.00", currency: "AUD" }] },
          { lockOverrideReason: "Trying to post into a formerly soft-locked period" },
        );
      await expect(tryPost("2026-01-15")).rejects.toThrow(/no one can post/i);
      await expect(tryPost("2026-02-15")).rejects.toThrow(PeriodLockedError);
      await expect(tryPost("2026-03-15")).resolves.toBeDefined();
    } finally {
      await admin.end();
    }
  });
});
