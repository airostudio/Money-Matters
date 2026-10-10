import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPools, resetDatabase } from "../../helpers/db";
import { addLinkedClient, createPracticeWorld, joinClient, revokeConsent, type PracticeWorld } from "../../helpers/practice";
import { D, seedCloseScenario } from "../../helpers/close";
import { createPayrollFixtures } from "../../helpers/payroll";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";
import { AGENT_MODES } from "@/domain/ai-controller/specialist-agents";
import { FinancialControllerService } from "@/domain/ai-controller/financial-controller-service";
import { AUTO_APPROVABLE_ACTION_TYPES } from "@/domain/ai-controller/auto-execution-policy";
import { AccountService } from "@/domain/accounts/account-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { HealthService } from "@/domain/practice/health-service";
import { WorkpaperService } from "@/domain/practice/workpaper-service";
import { workpaperFacts } from "@/domain/practice/assistant-views";
import { WorkpaperCommentaryService } from "@/domain/practice/workpaper-commentary";
import type { Actor } from "@/domain/permissions/permission-service";

const NOW = new Date("2026-10-05T10:00:00Z");

const tool = (name: string) => {
  const def = buildControllerTools([]).find((t) => t.name === name);
  if (!def) throw new Error(`${name} not registered`);
  return def;
};

describe("AI Financial Controller — practice_overview and workpaper_status (read-only, permission parity, no leak)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  let w: PracticeWorld;
  let wpIds: { a: string };
  let bankA = "";

  /** The chat happens in client A, as S1's real Actor there. */
  const chat = (role: Actor["role"] = "ACCOUNTANT"): Actor => w.s1In("A", role);

  beforeEach(async () => {
    await resetDatabase();
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
    w = await createPracticeWorld();
    for (const key of ["A", "B", "C", "D"] as const) await seedCloseScenario(w.clients[key].owner, "AUD");
    // Client A also has a bank account balance for a workpaper.
    const bank = await AccountService.create(w.clients.A.owner, { code: "1200", name: "Savings", type: "ASSET", currency: "AUD" });
    const equity = await AccountService.create(w.clients.A.owner, { code: "3200", name: "Savings Capital", type: "EQUITY", currency: "AUD" });
    bankA = bank.id;
    await PostingService.postJournal(w.clients.A.owner, { postingDate: D("2026-09-10"), lines: [{ accountId: bank.id, debit: "5000.00", currency: "AUD" }, { accountId: equity.id, credit: "5000.00", currency: "AUD" }] });
    const created = await WorkpaperService.create(w.s1Actor, w.practiceId, { clientOrganizationId: w.clients.A.organizationId, accountId: bankA, periodEnd: "2026-09-30" }, NOW);
    wpIds = { a: created.id };
    await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW);
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  describe("shape: read-only and outside every write / autonomy path", () => {
    it("both are read tools offered to the general controller, declare financial_report:read, and accept no organization, client or account ids", () => {
      for (const name of ["practice_overview", "workpaper_status"]) expect(tool(name).permission).toBe("financial_report:read");
      expect(AGENT_MODES.GENERAL.readToolNames).toBeNull();
      expect(Object.keys((tool("practice_overview").inputSchema as { properties: object }).properties).sort()).toEqual(["filter", "page", "practice"]);
      expect(Object.keys((tool("workpaper_status").inputSchema as { properties: object }).properties).sort()).toEqual(["client", "practice", "status"]);

      const writeTools = buildWriteTools("anything", "model");
      expect(writeTools.every((t) => t.name.startsWith("prepare_draft_"))).toBe(true);
      const all = [...buildControllerTools([]), ...writeTools].map((t) => t.name);
      // No practice write tool of any kind, and no tool that could close, lock, sign off, reopen, link, assign or refresh.
      expect(all.filter((n) => /practice|workpaper|signoff|sign_off|reopen|link|assign|refresh_client|client_request/i.test(n)).sort()).toEqual(["practice_overview", "workpaper_status"]);
      expect(all.filter((n) => /close_period|lock_period|period_lock|reopen_period/i.test(n))).toEqual([]);
    });

    it("the existing human-only guarantees hold: period close is not an AI tool, and the auto-execution policy gained nothing practice-related", () => {
      expect([...AUTO_APPROVABLE_ACTION_TYPES].filter((t) => /practice|workpaper|client|period|close|lock|sign/i.test(t))).toEqual([]);
      expect(buildControllerTools([]).filter((t) => /close_period|lock/.test(t.name))).toEqual([]);
    });
  });

  describe("results (from saved snapshots and the practice's own records)", () => {
    it("practice_overview lists only the clients S1 can read, with their saved figures, the snapshot age and the honesty caveats", async () => {
      const outcome = await tool("practice_overview").execute(chat(), { filter: "ALL" });
      if (!outcome.ok) throw new Error(`expected ok: ${outcome.error}`);
      expect(outcome.summary).toContain(`${w.clients.A.name}: Books —`);
      expect(outcome.summary).toContain("1 unreconciled, 1 uncategorised");
      expect(outcome.summary).toContain("SAVED SNAPSHOT figures (not live");
      expect(outcome.summary).toContain("never present a BAS figure");
      expect(outcome.summary).toContain("1 linked client(s) are excluded — this user has no access to them"); // D
      expect(outcome.citation.tool).toBe("practice_overview");
    });

    it("workpaper_status reports the snapshot balance, status and the computed reconciliation", async () => {
      await WorkpaperService.setSchedule(w.s1Actor, w.practiceId, wpIds.a, [{ kind: "SUPPORTING_BALANCE", description: "Statement", amount: "4900.00" }]);
      const outcome = await tool("workpaper_status").execute(chat(), {});
      if (!outcome.ok) throw new Error(`expected ok: ${outcome.error}`);
      expect(outcome.summary).toContain(`${w.clients.A.name} — 1200 Savings as at 2026-09-30: DRAFT (version 1), ledger balance 5000.00`);
      expect(outcome.summary).toContain("Ledger balance 5000.00 AUD; supporting schedule total 4900.00; difference (ledger minus schedule) 100.00 — NOT reconciled");
      expect(outcome.summary).toContain("adjustments are proposals only and are never posted");
    });

    it("a user with no practice is told so (nothing is invented)", async () => {
      const none = await tool("practice_overview").execute({ userId: w.outsider.id, organizationId: w.clients.A.organizationId, role: "READ_ONLY" }, {});
      if (!none.ok) throw new Error("expected ok");
      expect(none.summary).toContain("not a member of any accountant practice");
    });
  });

  describe("permission parity: the person's own role in each client limits what is said", () => {
    it("payroll is 'not visible' to a role without payrun:read even though the saved snapshot holds the figure", async () => {
      const owner = w.clients.A.owner;
      const wiring = await createPayrollFixtures(owner, "AUD");
      const employee = await EmployeeService.create(owner, { name: "Alex Salary", employmentBasis: "SALARY", annualSalary: "104000.00", payFrequency: "FORTNIGHTLY", taxFreeThresholdClaimed: true, startDate: D("2026-01-01") });
      await PayRunService.create(owner, { payFrequency: "FORTNIGHTLY", periodStart: D("2026-09-05"), periodEnd: D("2026-09-18"), payDate: D("2026-09-18"), employeeIds: [employee.id] }, wiring);
      await HealthService.refreshClient(w.s1Actor, w.practiceId, w.clients.A.organizationId, NOW); // as ACCOUNTANT: snapshot holds "1 draft pay run"

      const accountant = await tool("practice_overview").execute(chat(), { filter: "ALL" });
      if (!accountant.ok) throw new Error("expected ok");
      expect(accountant.summary).toContain("Payroll — 1 draft pay run");

      const membershipId = (await OrganizationService.listMembers(owner)).find((m) => m.userId === w.s1.id)!.membershipId;
      await OrganizationService.updateMemberRole(owner, membershipId, "MANAGER");
      const manager = await tool("practice_overview").execute(chat("MANAGER"), { filter: "ALL" });
      if (!manager.ok) throw new Error("expected ok");
      expect(manager.summary).toContain("Payroll — Not visible to your role");
      expect(manager.summary).not.toContain("draft pay run");
    });

    it("a role without financial_report:read in the chat organization is refused outright", async () => {
      for (const name of ["practice_overview", "workpaper_status"]) {
        const outcome = await tool(name).execute(chat("EMPLOYEE"), {});
        expect(outcome.ok, name).toBe(false);
        if (outcome.ok) throw new Error("expected refusal");
        expect(outcome.error).toMatch(/access denied/i);
        expect(outcome.error).toContain("financial_report:read");
      }
    });

    it("a client S1 can no longer read (role lacks journal:read) drops out of workpaper_status and is counted, not named", async () => {
      const owner = w.clients.A.owner;
      const membershipId = (await OrganizationService.listMembers(owner)).find((m) => m.userId === w.s1.id)!.membershipId;
      await OrganizationService.updateMemberRole(owner, membershipId, "EMPLOYEE");
      const outcome = await tool("workpaper_status").execute(chat("MANAGER"), {}); // the chat gate passes; the per-client gate is S1's REAL role (EMPLOYEE)
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.summary).toContain("1 workpaper(s) are excluded");
      expect(outcome.summary).not.toContain("1200 Savings");
      expect(outcome.summary).not.toContain(w.clients.A.name);
    });
  });

  describe("NO LEAK: nothing about an unreachable, pending, revoked or foreign client reaches the output or the model", () => {
    it("excluded clients and the workpapers of a client the viewer is not a member of appear only as counts", async () => {
      // A second client where ONLY S2 is a member: S2 prepares a workpaper there; S1 must never see it.
      const other = await addLinkedClient(w, "client-secret-e", { s1Role: null });
      await joinClient(other, w.s2, "ACCOUNTANT");
      const cash = await AccountService.create(other.owner, { code: "1500", name: "Hidden Cash", type: "ASSET", currency: "AUD" });
      const cap = await AccountService.create(other.owner, { code: "3500", name: "Hidden Capital", type: "EQUITY", currency: "AUD" });
      await PostingService.postJournal(other.owner, { postingDate: D("2026-09-05"), lines: [{ accountId: cash.id, debit: "88888.00", currency: "AUD" }, { accountId: cap.id, credit: "88888.00", currency: "AUD" }] });
      await WorkpaperService.create(w.s2Actor, w.practiceId, { clientOrganizationId: other.organizationId, accountId: cash.id, periodEnd: "2026-09-30" }, NOW);
      await HealthService.refreshClient(w.s2Actor, w.practiceId, other.organizationId, NOW);

      for (const [name, args] of [["practice_overview", { filter: "ALL" }], ["workpaper_status", {}]] as const) {
        const outcome = await tool(name).execute(chat(), args);
        if (!outcome.ok) throw new Error("expected ok");
        const text = JSON.stringify(outcome);
        for (const hidden of [other.name, other.slug, other.organizationId, w.clients.B.name, w.clients.C.name, w.clients.D.name, w.clients.D.organizationId, "88888", "Hidden Cash"]) {
          expect(text, `${name} leaked ${hidden}`).not.toContain(hidden);
        }
        expect(text).toMatch(/excluded/);
      }
    });

    it("a client that revokes drops out of both tools immediately", async () => {
      await revokeConsent(w.clients.A, w.practiceId);
      const overview = await tool("practice_overview").execute(chat(), { filter: "ALL" });
      if (!overview.ok) throw new Error("expected ok");
      expect(overview.summary).not.toContain(w.clients.A.name);
      expect(overview.summary).toContain("ended the practice's access");
      const papers = await tool("workpaper_status").execute(chat(), {}); // the paper is retained by the practice, but the assistant will not read a revoked client
      if (!papers.ok) throw new Error("expected ok");
      expect(papers.summary).not.toContain(w.clients.A.name);
      expect(papers.summary).not.toContain("1200 Savings");
    });

    it("end to end with the mocked model: every payload sent to the model is free of unauthorised data, and a write attempt is an unknown tool", async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t1", name: "practice_overview", input: { filter: "ALL" } }] })
        .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t2", name: "sign_off_workpaper", input: { id: wpIds.a } }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "One client needs attention; one linked client was excluded because you have no access to it." }] });
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

      const outcome = await FinancialControllerService.ask(chat(), "Which of our clients need attention?");
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("expected ok");
      expect(outcome.citations.map((c) => c.tool)).toEqual(["practice_overview"]);

      const offered = (create.mock.calls[0]![0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(offered).toContain("practice_overview");
      expect(offered).toContain("workpaper_status");
      expect(offered.filter((n) => /sign|reopen|close_period|lock|refresh|link/i.test(n))).toEqual([]);

      const everything = JSON.stringify(create.mock.calls.map((c) => c[0])) + outcome.answer;
      for (const hidden of [w.clients.B.name, w.clients.C.name, w.clients.D.name, w.clients.D.organizationId, w.clients.D.slug]) expect(everything).not.toContain(hidden);
      expect(everything).toContain(w.clients.A.name); // the authorised client reached the model
      expect(everything).toContain("1 linked client(s) are excluded");
      expect(everything).toContain('Unknown tool \\"sign_off_workpaper\\"');
      // And the workpaper is untouched.
      expect((await WorkpaperService.get(w.s1Actor, w.practiceId, wpIds.a)).workpaper.status).toBe("DRAFT");
    });
  });

  describe("optional workpaper commentary", () => {
    it("is handed only already-computed facts, and is omitted (null) with no API key or when the call fails", async () => {
      const detail = await WorkpaperService.get(w.s1Actor, w.practiceId, wpIds.a);
      const facts = workpaperFacts(detail).join("\n");
      expect(facts).toContain("Ledger balance 5000.00 AUD");
      expect(facts).toContain("difference (ledger minus schedule) 5000.00");
      expect(facts).not.toContain(w.clients.D.name);

      const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "The schedule is empty so the full balance is unreconciled." }] });
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
      expect(await WorkpaperCommentaryService.forWorkpaper(detail)).toContain("unreconciled");
      const sent = JSON.stringify(create.mock.calls[0]![0]);
      expect(sent).toContain("Ledger balance 5000.00 AUD");
      expect(sent).toMatch(/never calculate/i);

      delete process.env.ANTHROPIC_API_KEY;
      expect(await WorkpaperCommentaryService.forWorkpaper(detail)).toBeNull();
      process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn().mockRejectedValue(new Error("boom")) }; } }));
      expect(await WorkpaperCommentaryService.forWorkpaper(detail)).toBeNull();
    });
  });
});
