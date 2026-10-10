import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestPools, createTestUser, resetDatabase } from "../../helpers/db";
import { isPlatformAdminEmail } from "@/domain/platform-admin/identity";
import { createConsolidationWorld, createFullGroup, type ConsolidationWorld, type OrgKey } from "../../helpers/consolidation";
import { db } from "@/db/client";
import { withTenant } from "@/db/tenant";
import { auditLogs, journalEntries, journalLines, organizations } from "@/db/schema";
import { GroupService } from "@/domain/consolidation/group-service";
import { AdjustmentService } from "@/domain/consolidation/adjustment-service";
import {
  ConsolidationService,
  defaultConsolidationDeps,
  type ConsolidationDeps,
} from "@/domain/consolidation/consolidation-service";
import { entityAccountHref } from "@/domain/consolidation/drill-down";
import { GroupNotFoundError, MixedCurrencyError, NotAMemberOfEntityError } from "@/domain/consolidation/errors";
import { LedgerService } from "@/domain/ledger/ledger-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { ReportingService } from "@/domain/reporting/reporting-service";
import { AccountService } from "@/domain/accounts/account-service";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";

const FROM = new Date("2026-01-01");
const TO = new Date("2026-03-31");

async function designateLoan(world: ConsolidationWorld, groupId: string) {
  const A = world.entities.A;
  const B = world.entities.B;
  await GroupService.designateIntercompany(world.groupActor, groupId, {
    organizationId: A.organizationId,
    accountId: A.accountIds["1500"]!,
    kind: "LOAN_RECEIVABLE",
    counterpartyOrganizationId: B.organizationId,
  });
  await GroupService.designateIntercompany(world.groupActor, groupId, {
    organizationId: B.organizationId,
    accountId: B.accountIds["2500"]!,
    kind: "LOAN_PAYABLE",
    counterpartyOrganizationId: A.organizationId,
  });
}

/**
 * The slice's acceptance fixture: the consolidating user is OWNER in A,
 * ACCOUNTANT in B, READ_ONLY in C and NOT a member of D (D holds a distinctive
 * 99,999.00 that must never reach this user).
 */
async function buildScenario() {
  const world = await createConsolidationWorld();
  const group = await createFullGroup(world);
  await designateLoan(world, group.id); // while the user is still OWNER everywhere
  await world.setUserRole("B", "ACCOUNTANT");
  await world.setUserRole("C", "READ_ONLY");
  await world.removeUser("D");
  return { world, group };
}

describe("Consolidated reports — authorised entities only, hand-verified numbers", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it("consolidates exactly the entities the user may read (A, B, C), excludes D, and says so", async () => {
    const { world, group } = await buildScenario();
    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);

    expect(bs.entities.map((e) => e.name).sort()).toEqual(
      [world.entities.A.name, world.entities.B.name, world.entities.C.name].sort(),
    );
    expect(bs.exclusions.count).toBe(1);
    expect(bs.exclusions.notice).toBe("1 entity excluded — no access");
    // D is not a member: not named, not described, not even counted among known names.
    expect(bs.exclusions.knownNames).toEqual([]);

    // Nothing from D anywhere in the output.
    const json = JSON.stringify(bs);
    expect(json).not.toContain("99999");
    expect(json).not.toContain(world.entities.D.name);
    expect(json).not.toContain(world.entities.D.organizationId);
    expect(json).not.toContain(world.entities.D.slug);
  });

  it("Balance Sheet numbers, verified by hand across A, B and C with an intercompany loan", async () => {
    // A: cash 60,000 - 10,000 + 5,000 = 55,000; loan receivable 10,000; capital 60,000; current-year earnings 5,000
    // B: cash 10,000 + 2,000 - 800 = 11,200; loan payable 10,000; current-year earnings 2,000 - 800 = 1,200
    // C: cash 7,000; capital 7,000
    const { world, group } = await buildScenario();
    const A = world.entities.A.organizationId;
    const B = world.entities.B.organizationId;
    const C = world.entities.C.organizationId;
    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);

    expect(bs.assets.totals.byEntity[A]).toBe("65000.0000");
    expect(bs.assets.totals.byEntity[B]).toBe("11200.0000");
    expect(bs.assets.totals.byEntity[C]).toBe("7000.0000");
    expect(bs.assets.totals.combined).toBe("83200.0000");
    expect(bs.liabilities.totals.combined).toBe("10000.0000");
    expect(bs.equity.totals.combined).toBe("73200.0000"); // 60,000 + 7,000 capital + 5,000 + 1,200 earnings

    // Each entity's own sheet balances, and so does the combined column.
    expect(bs.difference.byEntity[A]).toBe("0.0000");
    expect(bs.difference.byEntity[B]).toBe("0.0000");
    expect(bs.difference.byEntity[C]).toBe("0.0000");
    expect(bs.difference.combined).toBe("0.0000");

    // The 10,000 loan is eliminated on both sides; the sheet still balances AFTER eliminations.
    expect(bs.assets.totals.eliminations).toBe("-10000.0000");
    expect(bs.liabilities.totals.eliminations).toBe("-10000.0000");
    expect(bs.assets.totals.consolidated).toBe("73200.0000");
    expect(bs.liabilities.totals.consolidated).toBe("0.0000");
    expect(bs.equity.totals.consolidated).toBe("73200.0000");
    expect(bs.difference.consolidated).toBe("0.0000");
    expect(bs.isBalanced).toBe(true);
    expect(bs.isConsolidatedBalanced).toBe(true);

    expect(bs.reconciliation).toHaveLength(1);
    expect(bs.reconciliation[0]).toMatchObject({ status: "MATCHED", matched: "10000.0000", difference: "0.0000" });
    expect(bs.unmapped.count).toBe(0);

    // The consolidated cash line is the sum of the three banks.
    const cash = bs.assets.lines.find((l) => l.code === "1000")!;
    expect(cash.consolidated).toBe("73200.0000");
    expect(cash.byEntity[A]).toBe("55000.0000");

    // Each entity's own Balance Sheet (the source of the columns) agrees to the cent.
    const direct = await ReportingService.getBalanceSheet(world.actorIn("B", "ACCOUNTANT"), TO);
    expect(direct.totalAssets).toBe(bs.assets.totals.byEntity[B]);
  });

  it("a deliberately mismatched loan is reported as an exception and never forced to net to zero", async () => {
    const { world, group } = await buildScenario();
    const A = world.entities.A;
    // A books a further 500 loan to B that B never recorded.
    await PostingService.postJournal(A.ownerActor, {
      postingDate: new Date("2026-03-01"),
      memo: "Further loan to B (B has not recorded it)",
      lines: [
        { accountId: A.accountIds["1500"]!, debit: "500.00", currency: "AUD" },
        { accountId: A.accountIds["1000"]!, credit: "500.00", currency: "AUD" },
      ],
    });
    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);

    expect(bs.reconciliation).toHaveLength(1);
    expect(bs.reconciliation[0]).toMatchObject({
      status: "MISMATCH",
      matched: "10000.0000",
      difference: "500.0000", // A: 10,500 ; B: 10,000
    });
    expect(bs.reconciliation[0]!.creditor).toMatchObject({ amount: "10500.0000" });
    expect(bs.reconciliation[0]!.debtor).toMatchObject({ amount: "10000.0000" });
    // The 500 stays in consolidated assets (as receivable) and the sheet still balances exactly.
    expect(bs.assets.lines.find((l) => l.code === "1500")!.consolidated).toBe("500.0000");
    expect(bs.isBalanced).toBe(true);
  });

  it("Profit & Loss numbers and per-entity columns", async () => {
    const { world, group } = await buildScenario();
    const A = world.entities.A.organizationId;
    const B = world.entities.B.organizationId;
    const C = world.entities.C.organizationId;
    const pl = await ConsolidationService.profitAndLoss(world.groupActor, group.id, { from: FROM, to: TO });

    expect(pl.revenue.totals.byEntity[A]).toBe("5000.0000");
    expect(pl.revenue.totals.byEntity[B]).toBe("2000.0000");
    expect(pl.revenue.totals.byEntity[C]).toBe("0.0000");
    expect(pl.revenue.totals.consolidated).toBe("7000.0000");
    expect(pl.expenses.totals.consolidated).toBe("800.0000");
    expect(pl.netProfit.byEntity[B]).toBe("1200.0000");
    expect(pl.netProfit.consolidated).toBe("6200.0000");
    const sales = pl.revenue.lines.find((l) => l.code === "4000")!;
    expect(sales.sources.map((s) => s.organizationId).sort()).toEqual([A, B].sort());
    expect(pl.exclusions.notice).toBe("1 entity excluded — no access");
  });

  it("intercompany revenue/expense is eliminated in the P&L without changing net profit", async () => {
    const { world, group } = await buildScenario();
    const A = world.entities.A;
    const B = world.entities.B;
    // A charges B a 1,500 management fee: A books IC revenue, B books IC expense.
    await PostingService.postJournal(A.ownerActor, {
      postingDate: new Date("2026-03-10"),
      lines: [
        { accountId: A.accountIds["1000"]!, debit: "1500.00", currency: "AUD" },
        { accountId: A.accountIds["4100"]!, credit: "1500.00", currency: "AUD" },
      ],
    });
    await PostingService.postJournal(B.ownerActor, {
      postingDate: new Date("2026-03-10"),
      lines: [
        { accountId: B.accountIds["6100"]!, debit: "1500.00", currency: "AUD" },
        { accountId: B.accountIds["1000"]!, credit: "1500.00", currency: "AUD" },
      ],
    });
    await GroupService.designateIntercompany(world.groupActor, group.id, {
      organizationId: A.organizationId,
      accountId: A.accountIds["4100"]!,
      kind: "REVENUE",
      counterpartyOrganizationId: B.organizationId,
    });
    await GroupService.designateIntercompany(world.groupActor, group.id, {
      organizationId: B.organizationId,
      accountId: B.accountIds["6100"]!,
      kind: "EXPENSE",
      counterpartyOrganizationId: A.organizationId,
    });
    const pl = await ConsolidationService.profitAndLoss(world.groupActor, group.id, { from: FROM, to: TO });
    expect(pl.revenue.totals.combined).toBe("8500.0000");
    expect(pl.revenue.totals.eliminations).toBe("-1500.0000");
    expect(pl.revenue.totals.consolidated).toBe("7000.0000");
    expect(pl.expenses.totals.consolidated).toBe("800.0000");
    expect(pl.netProfit.consolidated).toBe(pl.netProfit.combined); // 6,200 either way
    expect(pl.netProfit.consolidated).toBe("6200.0000");
    expect(pl.reconciliation[0]).toMatchObject({ category: "INCOME_EXPENSE", status: "MATCHED", matched: "1500.0000" });
  });

  it("cash position sums the included entities' bank balances", async () => {
    const { world, group } = await buildScenario();
    const cash = await ConsolidationService.cash(world.groupActor, group.id, TO);
    expect(cash.total).toBe("73200.0000"); // 55,000 + 11,200 + 7,000
    expect(cash.entities.map((e) => e.total).sort()).toEqual(["11200.0000", "55000.0000", "7000.0000"]);
    expect(JSON.stringify(cash)).not.toContain("99999");
    expect(cash.exclusions.notice).toBe("1 entity excluded — no access");
  });

  it("an entity where the user lacks financial_report:read is excluded; a known name is only given for entities the user belongs to", async () => {
    const { world, group } = await buildScenario();
    await world.setUserRole("C", "EMPLOYEE"); // EMPLOYEE has no financial_report:read
    const pl = await ConsolidationService.profitAndLoss(world.groupActor, group.id, { from: FROM, to: TO });

    expect(pl.entities.map((e) => e.name)).not.toContain(world.entities.C.name);
    expect(pl.exclusions.count).toBe(2); // C (no permission) and D (not a member)
    expect(pl.exclusions.notice).toBe("2 entities excluded — no access");
    // C's name is known to a current member; D's never appears.
    expect(pl.exclusions.knownNames).toEqual([world.entities.C.name]);
    expect(JSON.stringify(pl)).not.toContain(world.entities.D.name);
    expect(pl.revenue.totals.consolidated).toBe("7000.0000");

    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
    expect(bs.assets.totals.combined).toBe("76200.0000");
    expect(bs.isBalanced).toBe(true);
  });

  it("losing membership in an entity removes it from the next report and leaves its counterparty balances reported, not eliminated", async () => {
    const { world, group } = await buildScenario();
    await world.removeUser("B");
    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
    expect(bs.entities.map((e) => e.name).sort()).toEqual([world.entities.A.name, world.entities.C.name].sort());
    expect(bs.exclusions.count).toBe(2);
    // B left the group's view, so A's loan receivable is no longer matched: reported, not eliminated.
    expect(bs.reconciliation[0]).toMatchObject({ status: "COUNTERPARTY_UNAVAILABLE", matched: "0.0000", debtor: null });
    expect(JSON.stringify(bs)).not.toContain(world.entities.B.name);
    expect(bs.isBalanced).toBe(true);
  });

  it("the group view marks lapsed entities as unavailable without naming them", async () => {
    const { world, group } = await buildScenario();
    const detail = await GroupService.get(world.groupActor, group.id);
    const d = detail.members.find((m) => m.organizationId === world.entities.D.organizationId)!;
    expect(d.accessible).toBe(false);
    expect(d.name).toBeNull();
    expect(d.slug).toBeNull();
    expect(JSON.stringify(detail)).not.toContain(world.entities.D.name);
  });

  it("drill-down links point at the ENTITY's own page, which re-checks permission", async () => {
    const { world, group } = await buildScenario();
    const pl = await ConsolidationService.profitAndLoss(world.groupActor, group.id, { from: FROM, to: TO });
    const sales = pl.revenue.lines.find((l) => l.code === "4000")!;
    const bSource = sales.sources.find((s) => s.organizationId === world.entities.B.organizationId)!;
    const href = entityAccountHref(bSource, { from: "2026-01-01", to: "2026-03-31" })!;
    expect(href).toBe(
      `/${world.entities.B.slug}/accounting/accounts/${world.entities.B.accountIds["4000"]}/transactions?from=2026-01-01&to=2026-03-31`,
    );

    // The link's account is a real account of B, and B's own service serves it to the ACCOUNTANT ...
    const account = await AccountService.get(world.actorIn("B", "ACCOUNTANT"), bSource.accountId!);
    expect(account?.code).toBe("4000");
    const rows = await ReportingService.getAccountTransactions(world.actorIn("B", "ACCOUNTANT"), bSource.accountId!, { from: FROM, to: TO });
    expect(rows.length).toBeGreaterThan(0);
    // ... but refuses a role that cannot read journals (the entity page re-checks; consolidation grants nothing).
    await expect(
      ReportingService.getAccountTransactions(world.actorIn("B", "EMPLOYEE"), bSource.accountId!, { from: FROM, to: TO }),
    ).rejects.toThrow(PermissionDeniedError);

    // Computed lines (retained earnings) have no single account and no link.
    expect(entityAccountHref({ organizationSlug: "x", accountId: null }, { to: "2026-01-01" })).toBeNull();
  });

  it("refuses mixed base currencies with a specific message instead of adding unlike currencies", async () => {
    const { world, group } = await buildScenario();
    await db.update(organizations).set({ baseCurrency: "NZD" }).where(eq(organizations.id, world.entities.B.organizationId));

    const rejection = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO).catch((e) => e);
    expect(rejection).toBeInstanceOf(MixedCurrencyError);
    expect((rejection as Error).message).toContain("different base currencies: AUD, NZD");
    expect((rejection as Error).message).toContain("currency translation is not yet supported");
    await expect(ConsolidationService.profitAndLoss(world.groupActor, group.id, { from: FROM, to: TO })).rejects.toThrow(MixedCurrencyError);
    await expect(ConsolidationService.cash(world.groupActor, group.id, TO)).rejects.toThrow(MixedCurrencyError);
  });

  it("never reveals an unauthorised entity's currency: a foreign-currency entity the user cannot access does not trigger the refusal", async () => {
    const { world, group } = await buildScenario();
    await db.update(organizations).set({ baseCurrency: "USD" }).where(eq(organizations.id, world.entities.D.organizationId));
    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
    expect(bs.currency).toBe("AUD");
    expect(JSON.stringify(bs)).not.toContain("USD");
  });
});

describe("Consolidation access discipline: sequential, bounded, per-entity", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  function instrumented() {
    const log: Array<{ op: string; orgId: string; role: string; t: "start" | "end" }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const wrap =
      <A extends unknown[], R>(op: string, fn: (actor: { organizationId: string; role: string }, ...rest: A) => Promise<R>) =>
      async (actor: { organizationId: string; role: string }, ...rest: A): Promise<R> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        log.push({ op, orgId: actor.organizationId, role: actor.role, t: "start" });
        try {
          return await fn(actor, ...rest);
        } finally {
          inFlight -= 1;
          log.push({ op, orgId: actor.organizationId, role: actor.role, t: "end" });
        }
      };
    const deps: ConsolidationDeps = {
      getProfitAndLoss: wrap("pl", (a, r: Parameters<ConsolidationDeps["getProfitAndLoss"]>[1]) => defaultConsolidationDeps.getProfitAndLoss(a as never, r)),
      getBalanceSheet: wrap("bs", (a, d: Date) => defaultConsolidationDeps.getBalanceSheet(a as never, d)),
      loadCashPosition: wrap("cash", (a, d: Date) => defaultConsolidationDeps.loadCashPosition(a as never, d)),
    } as ConsolidationDeps;
    return { deps, log, maxInFlight: () => maxInFlight };
  }

  it("fetches one entity at a time (never more than one in flight), only entities the user may reach, with the user's real role in each", async () => {
    const { world, group } = await buildScenario();
    const probe = instrumented();
    await ConsolidationService.balanceSheet(world.groupActor, group.id, TO, probe.deps);

    expect(probe.maxInFlight()).toBe(1);
    const starts = probe.log.filter((l) => l.t === "start");
    // A (OWNER), B (ACCOUNTANT), C (READ_ONLY): in group order; D (not a member) is never called.
    expect(starts.map((s) => s.orgId)).toEqual([
      world.entities.A.organizationId,
      world.entities.B.organizationId,
      world.entities.C.organizationId,
    ]);
    expect(starts.map((s) => s.role)).toEqual(["OWNER", "ACCOUNTANT", "READ_ONLY"]);
    expect(starts.some((s) => s.orgId === world.entities.D.organizationId)).toBe(false);
    // Strict start/end alternation == fully sequential.
    expect(probe.log.map((l) => l.t)).toEqual(["start", "end", "start", "end", "start", "end"]);

    const cash = instrumented();
    await ConsolidationService.cash(world.groupActor, group.id, TO, cash.deps);
    expect(cash.maxInFlight()).toBe(1);
  });

  it("a platform admin has no special access: they cannot read the group, add an entity they are not in, or consolidate anything", async () => {
    const { world, group } = await buildScenario();
    const admin = await createTestUser("Platform Admin");
    const previous = process.env.PLATFORM_ADMIN_EMAILS;
    process.env.PLATFORM_ADMIN_EMAILS = admin.email;
    try {
      expect(isPlatformAdminEmail(admin.email)).toBe(true);
      const adminActor = { userId: admin.id };
      await expect(ConsolidationService.balanceSheet(adminActor, group.id, TO)).rejects.toThrow(GroupNotFoundError);
      await expect(GroupService.get(adminActor, group.id)).rejects.toThrow(GroupNotFoundError);
      const ownGroup = await GroupService.create(adminActor, { name: "Admin's own" });
      await expect(GroupService.addEntity(adminActor, ownGroup.id, world.entities.A.organizationId)).rejects.toThrow(NotAMemberOfEntityError);
      // Their own (empty) group consolidates to nothing at all.
      const empty = await ConsolidationService.balanceSheet(adminActor, ownGroup.id, TO);
      expect(empty.entities).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
      else process.env.PLATFORM_ADMIN_EMAILS = previous;
    }
  });
});

describe("Adjustments and consolidation never touch any entity's ledger", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  async function ledgerFingerprint(world: ConsolidationWorld, key: OrgKey) {
    const org = world.entities[key].organizationId;
    const { entries, lines, logs } = await withTenant(org, async (tx) => ({
      entries: await tx.select().from(journalEntries).orderBy(journalEntries.entryNumber),
      lines: await tx.select().from(journalLines).orderBy(journalLines.id),
      logs: await tx.select().from(auditLogs).orderBy(auditLogs.id),
    }));
    const trialBalance = await LedgerService.getTrialBalance(world.entities[key].ownerActor, TO);
    return JSON.stringify({ entries, lines, trialBalance, auditLogIds: logs.map((l) => l.id) });
  }

  it("entity ledgers (journal entries, lines, trial balance, audit log) are byte-identical before and after adjustments and consolidation", async () => {
    const { world, group } = await buildScenario();
    const keys: OrgKey[] = ["A", "B", "C", "D"];
    const before: Record<string, string> = {};
    for (const k of keys) before[k] = await ledgerFingerprint(world, k);

    const detail = await GroupService.get(world.groupActor, group.id);
    const cash = detail.config.groupAccounts.find((g) => g.code === "1000")!;
    const sales = detail.config.groupAccounts.find((g) => g.code === "4000")!;
    const first = await AdjustmentService.create(world.groupActor, group.id, {
      kind: "ADJUSTMENT",
      effectiveDate: new Date("2026-03-31"),
      description: "Group-level reclass",
      reason: "Test",
      lines: [
        { groupAccountId: cash.id, debit: "100.1234" },
        { groupAccountId: sales.id, credit: "100.1234" },
      ],
    });
    await AdjustmentService.reverse(world.groupActor, group.id, first.id, { reason: "Undo" });
    await AdjustmentService.create(world.groupActor, group.id, {
      kind: "ELIMINATION",
      effectiveDate: new Date("2026-03-31"),
      description: "Another",
      reason: "Test",
      lines: [
        { groupAccountId: sales.id, debit: "50" },
        { groupAccountId: cash.id, credit: "50" },
      ],
    });
    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
    await ConsolidationService.profitAndLoss(world.groupActor, group.id, { from: FROM, to: TO });
    await ConsolidationService.cash(world.groupActor, group.id, TO);

    // The adjustments DID change the consolidated figures ...
    expect(bs.adjustments.length).toBeGreaterThan(0);
    expect(bs.isBalanced).toBe(true);
    // ... and no entity's books moved at all.
    for (const k of keys) expect(await ledgerFingerprint(world, k), k).toBe(before[k]);

    // Adjustments exist only in group-level tables.
    expect((await AdjustmentService.list(world.groupActor, group.id)).length).toBe(3);
  });

  it("adjustments move only the consolidated column and the sheet stays balanced to the cent", async () => {
    const { world, group } = await buildScenario();
    const detail = await GroupService.get(world.groupActor, group.id);
    const cash = detail.config.groupAccounts.find((g) => g.code === "1000")!;
    const expenses = detail.config.groupAccounts.find((g) => g.code === "6000")!;
    await AdjustmentService.create(world.groupActor, group.id, {
      kind: "ADJUSTMENT",
      effectiveDate: new Date("2026-02-28"),
      description: "Accrue group audit fee",
      reason: "Fee not booked in any entity",
      lines: [
        { groupAccountId: expenses.id, debit: "333.3333" },
        { groupAccountId: cash.id, credit: "333.3333" },
      ],
    });
    const bs = await ConsolidationService.balanceSheet(world.groupActor, group.id, TO);
    expect(bs.assets.totals.adjustments).toBe("-333.3333");
    const earnings = bs.equity.lines.find((l) => l.name === "Current Year Earnings")!;
    expect(earnings.adjustments).toBe("-333.3333");
    expect(bs.assets.totals.consolidated).toBe("72866.6667"); // 73,200 - 333.3333
    expect(bs.isBalanced).toBe(true);

    const pl = await ConsolidationService.profitAndLoss(world.groupActor, group.id, { from: FROM, to: TO });
    expect(pl.expenses.totals.adjustments).toBe("333.3333");
    expect(pl.netProfit.consolidated).toBe("5866.6667"); // 6,200 - 333.3333

    // Outside the effective date it does not apply.
    const early = await ConsolidationService.balanceSheet(world.groupActor, group.id, new Date("2026-02-01"));
    expect(early.adjustments).toHaveLength(0);
  });
});
