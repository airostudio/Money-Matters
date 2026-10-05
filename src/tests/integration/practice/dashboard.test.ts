import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeTestPools, resetDatabase } from "../../helpers/db";
import { addLinkedClient, createPracticeWorld, revokeConsent, type PracticeWorld } from "../../helpers/practice";
import { D, seedCloseScenario } from "../../helpers/close";
import { createPayrollFixtures } from "../../helpers/payroll";
import { tracker } from "../../helpers/connection-tracker";
import { withUserScope } from "@/db/user-scope";
import { clientHealthSnapshots } from "@/db/schema";
import { HealthService, focusPeriodKey } from "@/domain/practice/health-service";
import { TaskService } from "@/domain/practice/task-service";
import { BulkService } from "@/domain/practice/bulk-service";
import { BulkSelectionError } from "@/domain/practice/errors";
import { DASHBOARD_PAGE_SIZE } from "@/domain/practice/types";
import { CloseChecklistService } from "@/domain/close/checklist-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { OrganizationService } from "@/domain/organizations/organization-service";

vi.mock("@/db/tenant", async (orig) => (await import("../../helpers/connection-tracker")).instrumentTenant(await orig<typeof import("@/db/tenant")>()));
vi.mock("@/db/user-scope", async (orig) => (await import("../../helpers/connection-tracker")).instrumentUserScope(await orig<typeof import("@/db/user-scope")>()));

const NOW = new Date("2026-10-05T10:00:00Z");

describe("Practice dashboard — materialised snapshots, per-viewer redaction, sequential and bounded", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let w: PracticeWorld;
  let scenario: Awaited<ReturnType<typeof seedCloseScenario>>;

  beforeEach(async () => {
    await resetDatabase();
    w = await createPracticeWorld();
    // Client A has real, hand-checkable activity (September 2026): one unreconciled bank transaction (-4.50),
    // one DRAFT invoice (200.00), a posted journal of 1,000.00. Every other client has books too, but a
    // different shape — so any leak of B, C or D data into S1's view would be visible.
    scenario = await seedCloseScenario(w.clients.A.owner, "AUD");
    for (const key of ["B", "C", "D"] as const) await seedCloseScenario(w.clients[key].owner, "AUD");
    tracker.reset();
  });

  const snapshotRow = async (key: "A" | "B" | "C" | "D") =>
    (await withUserScope(w.partner.id, (tx) => tx.select().from(clientHealthSnapshots).where(eq(clientHealthSnapshots.clientOrganizationId, w.clients[key].organizationId))))[0];

  describe("refreshing one client", () => {
    it("computes the indicators from the client's own engines, matching the live close checklist and the data we seeded", async () => {
      const result = await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      expect(result).toMatchObject({ state: "OK", clientName: w.clients.A.name });

      const snap = (await snapshotRow("A"))!;
      const checklist = await CloseChecklistService.compute(w.s1In("A"), "2026-09");
      expect(focusPeriodKey(NOW)).toBe("2026-09");
      expect(snap).toMatchObject({
        state: "OK",
        periodLabel: "2026-09",
        lockLevel: "OPEN",
        booksPercent: checklist.progress.percent,
        blockingCount: 0,
        unreconciledCount: 1, // the single -4.50 coffee
        uncategorisedCount: 1,
        draftPayRuns: 0,
        taxLockedThrough: null,
        computedByUserId: w.s1.id,
        computedByRole: "ACCOUNTANT",
      });
      // Attention = the unreconciled bank transaction and the draft invoice, exactly as the checklist reports them.
      expect(snap.attentionCount).toBe(checklist.items.filter((i) => i.status === "ATTENTION").length);
      expect(snap.attentionCount).toBeGreaterThanOrEqual(2);
      expect(snap.booksPercent).toBeGreaterThan(0);
      expect(snap.booksPercent).toBeLessThan(100);
      expect(snap.computedAt.toISOString()).toBe(NOW.toISOString());
    });

    it("reflects a fix once the client repairs the data and the practice refreshes again (nothing is live: it is the snapshot that moves)", async () => {
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      const before = (await snapshotRow("A"))!;
      await scenario.categorize();
      await scenario.approveInvoice();
      // Until refreshed, the dashboard still shows the old figures — honestly dated.
      expect((await snapshotRow("A"))!.unreconciledCount).toBe(1);
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, new Date("2026-10-05T12:00:00Z"));
      const after = (await snapshotRow("A"))!;
      expect(after.unreconciledCount).toBe(0);
      expect(after.booksPercent!).toBeGreaterThan(before.booksPercent!);
    });

    it("a draft pay run is counted for a role with payrun:read, and the figure is HIDDEN from a viewer whose own role lacks it", async () => {
      const owner = w.clients.A.owner;
      const wiring = await createPayrollFixtures(owner, "AUD");
      const employee = await EmployeeService.create(owner, {
        name: "Alex Salary",
        employmentBasis: "SALARY",
        annualSalary: "104000.00",
        payFrequency: "FORTNIGHTLY",
        taxFreeThresholdClaimed: true,
        startDate: D("2026-01-01"),
      });
      await PayRunService.create(
        owner,
        { payFrequency: "FORTNIGHTLY", periodStart: D("2026-09-05"), periodEnd: D("2026-09-18"), payDate: D("2026-09-18"), employeeIds: [employee.id] },
        wiring,
      );

      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW); // S1 is an ACCOUNTANT: has payrun:read
      expect((await snapshotRow("A"))!.draftPayRuns).toBe(1);
      let row = (await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW })).rows[0]!;
      expect(row.indicators.payroll).toEqual({ light: "AMBER", label: "1 draft pay run" });

      // The client moves S1 to MANAGER (no payrun:read). The SNAPSHOT still holds the figure, but S1 no longer sees it.
      const membershipId = (await OrganizationService.listMembers(owner)).find((m) => m.userId === w.s1.id)!.membershipId;
      await OrganizationService.updateMemberRole(owner, membershipId, "MANAGER");
      expect((await snapshotRow("A"))!.draftPayRuns).toBe(1);
      row = (await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW })).rows[0]!;
      expect(row.indicators.payroll).toEqual({ light: "GREY", label: "Not visible to your role" });
      expect(row.indicators.books.light).not.toBe("GREY"); // MANAGER still holds close_checklist:read
      expect(JSON.stringify(row)).not.toContain('"draftPayRuns"');

      // And a refresh BY that role stores "not measured", never a fabricated zero.
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      expect((await snapshotRow("A"))!.draftPayRuns).toBeNull();
    });
  });

  describe("who and what the dashboard shows", () => {
    it("S1's dashboard includes exactly client A: B (pending), C (revoked) and D (S1 is not a member) contribute no rows and no figures", async () => {
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      tracker.reset();
      const page = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW });

      expect(page.rows.map((r) => r.clientOrganizationId)).toEqual([w.clients.A.organizationId]);
      expect(page.totalMatching).toBe(1);
      expect(page.notAccessibleCount).toBe(1); // D: an ACTIVE link S1 cannot open — counted, never listed
      const blob = JSON.stringify(page);
      for (const key of ["B", "C", "D"] as const) {
        expect(blob).not.toContain(w.clients[key].name);
        expect(blob).not.toContain(w.clients[key].organizationId);
      }
      // The dashboard read nothing but the practice's own tables plus the consent check of the ONE row on the page.
      expect(tracker.tenantCalls).toEqual([w.clients.A.organizationId]);
      expect(tracker.maxActive).toBe(1);
    });

    it("refreshing B, C or D opens no tenant transaction for them and reports why, without leaking anything", async () => {
      tracker.reset();
      const b = await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.B.organizationId, NOW);
      const c = await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.C.organizationId, NOW);
      const d = await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.D.organizationId, NOW);
      expect([b.state, c.state, d.state]).toEqual(["LINK_INACTIVE", "LINK_INACTIVE", "NO_ACCESS"]);
      expect(d.message).toMatch(/not a member of/);
      expect(tracker.tenantCalls).toEqual([]); // B and C: link not active; D: not a member — none was opened
      for (const key of ["B", "C", "D"] as const) expect(await snapshotRow(key)).toBeUndefined();
    });

    it("the partner is a member of no client, so sees no rows (and is told how many linked clients are not theirs to open)", async () => {
      const page = await HealthService.dashboard(w.partnerActor, w.practiceId, { now: NOW });
      expect(page.rows).toEqual([]);
      expect(page.notAccessibleCount).toBe(2); // A and D are ACTIVE links; the partner holds no membership in either
      const refreshed = await HealthService.refreshClient(w.partnerActor, w.practiceId, w.clients.A.organizationId, NOW);
      expect(refreshed.state).toBe("NO_ACCESS");
    });

    it("sorts worst first and can filter to 'needs intervention'; a never-refreshed client ranks below a client with open items", async () => {
      // `quiet` has no activity (its checklist still has unsigned manual items, so it is only AMBER);
      // `fresh` has never been refreshed, so it has no figures at all.
      const quiet = await addLinkedClient(w, "client-quiet");
      const fresh = await addLinkedClient(w, "client-fresh");
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      await HealthService.refreshClient(w.s1Actor, w.practiceId, quiet.organizationId, NOW);

      const all = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW });
      // A (books AMBER + 1 unreconciled) is worse than quiet (books AMBER only), which is worse than never-refreshed.
      expect(all.rows.map((r) => r.clientName)).toEqual([w.clients.A.name, quiet.name, fresh.name]);
      const severities = all.rows.map((r) => r.indicators.severity);
      expect(severities[0]).toBeGreaterThan(severities[1]!);
      expect(severities[1]).toBeGreaterThan(severities[2]!);
      expect(all.rows[2]!.indicators.neverRefreshed).toBe(true);

      const needing = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW, filter: "NEEDS_INTERVENTION" });
      expect(needing.rows.map((r) => r.clientName)).toEqual([w.clients.A.name, quiet.name]); // fresh has nothing to act on yet
    });

    it("shows the snapshot's age honestly and marks it stale after a day", async () => {
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      const later = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: new Date("2026-10-05T12:00:00Z") });
      expect(later.rows[0]!.snapshot).toMatchObject({ age: "2 hours ago", stale: false });
      const muchLater = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: new Date("2026-10-07T10:00:00Z") });
      expect(muchLater.rows[0]!.snapshot).toMatchObject({ age: "2 days ago", stale: true });
    });

    it("BAS / Tax shows only the deadline the PRACTICE entered; overdue goes RED, completing it clears it", async () => {
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      expect((await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW })).rows[0]!.indicators.tax).toEqual({ light: "GREY", label: "No deadline entered" });

      const task = await TaskService.create(w.partnerActor, w.practiceId, {
        title: "Lodge September quarter",
        category: "BAS",
        dueDate: "2026-10-01",
        clientOrganizationId: w.clients.A.organizationId,
      });
      const row = (await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW })).rows[0]!;
      expect(row.indicators.tax).toMatchObject({ light: "RED" });
      expect(row.indicators.tax.label).toContain("overdue by 4 days (2026-10-01)");
      expect(row.indicators.issues).toBeGreaterThanOrEqual(1);

      await TaskService.complete(w.partnerActor, w.practiceId, task.id);
      expect((await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW })).rows[0]!.indicators.tax.light).toBe("GREY");
    });
  });

  describe("revocation", () => {
    it("the dashboard stops showing a client the moment its owner revokes — and the retained snapshot figures are blanked", async () => {
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      expect((await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW })).rows.length).toBe(1);

      await revokeConsent(w.clients.A, w.practiceId);
      tracker.reset();
      const page = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW });
      expect(page.rows).toEqual([]);
      expect(page.endedDuringLoad).toBe(1);

      const snap = (await snapshotRow("A"))!;
      expect(snap).toMatchObject({ state: "LINK_INACTIVE", unreconciledCount: null, booksPercent: null, draftPayRuns: null, attentionCount: null });
      // A refresh now reads nothing: only the consent check is opened.
      tracker.reset();
      const result = await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      expect(result.state).toBe("LINK_INACTIVE");
      expect(tracker.tenantCalls).toEqual([]); // the practice's own copy already says REVOKED: nothing is opened at all
    });

    it("a revocation that lands mid-refresh stops the remaining reads: the consent is re-checked before each group", async () => {
      // Revoke, but leave the practice's copy saying ACTIVE (it has not looked yet).
      await revokeConsent(w.clients.A, w.practiceId);
      tracker.reset();
      const result = await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
      expect(result.state).toBe("LINK_INACTIVE");
      // Only consent checks were opened (the guard, then the observation) — no engine ran.
      expect(tracker.tenantCalls.length).toBeGreaterThan(0);
      expect(tracker.tenantCalls.length).toBeLessThanOrEqual(2);
      expect(tracker.tenantCalls.every((id) => id === w.clients.A.organizationId)).toBe(true);
      expect((await snapshotRow("A"))?.booksPercent ?? null).toBeNull();
    });
  });

  describe("DB connection discipline: sequential, bounded, set-based", () => {
    it("a bulk refresh runs one client after another (never more than one scoped transaction open) and is capped at one page", async () => {
      // Make several accessible clients for S1.
      const extra: Array<{ organizationId: string }> = [];
      for (let i = 0; i < 3; i += 1) extra.push(await addLinkedClient(w, `client-x${i}`));

      tracker.reset();
      const ids = [w.clients.A.organizationId, ...extra.map((e) => e.organizationId)];
      const results = await BulkService.refresh(w.s1Actor, w.practiceId, ids, NOW);
      expect(results.map((r) => r.state)).toEqual(["OK", "OK", "OK", "OK"]);
      expect(tracker.maxActive).toBe(1);
      // Per client the order is strictly grouped: all of client N's tenant work happens before client N+1's.
      const order = tracker.tenantCalls.filter((id, i, a) => i === 0 || a[i - 1] !== id);
      expect(order).toEqual(ids);

      await expect(BulkService.refresh(w.s1Actor, w.practiceId, [], NOW)).rejects.toBeInstanceOf(BulkSelectionError);
      const eleven = Array.from({ length: DASHBOARD_PAGE_SIZE + 1 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`);
      await expect(BulkService.refresh(w.s1Actor, w.practiceId, eleven, NOW)).rejects.toBeInstanceOf(BulkSelectionError);
    });

    it("the dashboard is paginated: a practice with more than a page of clients loads ONE page, verifying only that page's consent, one at a time", async () => {
      const total = DASHBOARD_PAGE_SIZE + 3;
      for (let i = 0; i < total - 1; i += 1) await addLinkedClient(w, `client-p${i}`);

      tracker.reset();
      const page1 = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW, page: 1 });
      expect(page1.rows.length).toBe(DASHBOARD_PAGE_SIZE);
      expect(page1.totalMatching).toBe(total); // A plus the extras
      expect(page1.totalPages).toBe(2);
      // One consent check per ROW ON THE PAGE — not per client in the practice.
      expect(tracker.tenantCalls.length).toBe(DASHBOARD_PAGE_SIZE);
      expect(new Set(tracker.tenantCalls).size).toBe(DASHBOARD_PAGE_SIZE);
      expect(tracker.maxActive).toBe(1);

      const page2 = await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW, page: 2 });
      expect(page2.rows.length).toBe(total - DASHBOARD_PAGE_SIZE);
      const seen = new Set([...page1.rows, ...page2.rows].map((r) => r.clientOrganizationId));
      expect(seen.size).toBe(total);
      // An out-of-range page is clamped, never an error and never an unbounded query.
      expect((await HealthService.dashboard(w.s1Actor, w.practiceId, { now: NOW, page: 99 })).page).toBe(2);
    });
  });

  it("the snapshot table carries only counts: no amounts, no names, no descriptions", async () => {
    await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
    const snap = (await snapshotRow("A"))!;
    const blob = JSON.stringify(snap);
    expect(blob).not.toContain("Morning Coffee");
    expect(blob).not.toContain("4.50");
    expect(blob).not.toContain("Consulting");
    expect(Object.keys(snap).sort()).toEqual(
      [
        "attentionCount", "blockingCount", "booksPercent", "clientOrganizationId", "computedAt", "computedByRole", "computedByUserId", "detail", "draftPayRuns",
        "id", "lockLevel", "periodLabel", "practiceId", "state", "taxLockedThrough", "uncategorisedCount", "unreconciledCount",
      ].sort(),
    );
    expect(scenario.bankAccountId).toBeTruthy();
  });
});
