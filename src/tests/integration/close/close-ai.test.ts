import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { seedCloseScenario } from "../../helpers/close";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools, WRITE_TOOL_PERMISSIONS } from "@/domain/ai-controller/write-tools";
import { AGENT_MODES } from "@/domain/ai-controller/specialist-agents";
import { FinancialControllerService } from "@/domain/ai-controller/financial-controller-service";
import { AUTO_APPROVABLE_ACTION_TYPES, AutoApprovedActionsService, InvalidAutoApprovedActionTypeError, EXCLUDED_ACTION_TYPE_EXAMPLES } from "@/domain/ai-controller/auto-execution-policy";
import { AutonomySettingsService } from "@/domain/ai-controller/autonomy";
import { CloseChecklistService } from "@/domain/close/checklist-service";
import { CloseCommentaryService } from "@/domain/close/commentary";
import { checklistFacts } from "@/domain/close/checklist-summary";
import { PeriodCloseService } from "@/domain/close/period-close-service";
import { PeriodLockService } from "@/domain/close/period-lock-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { ROLE_PERMISSIONS } from "@/domain/permissions/roles";
import { withTenant } from "@/db/tenant";
import { fiscalPeriods } from "@/db/schema";

describe("Month-end close — AI (read-only status tool, optional commentary, no write path)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("close-ai");
    owner = org.owner;
    orgId = org.organizationId;
    await seedCloseScenario(owner, org.baseCurrency);
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  const tool = () => {
    const def = buildControllerTools([]).find((t) => t.name === "close_status");
    if (!def) throw new Error("close_status not registered");
    return def;
  };

  describe("close_status controller tool", () => {
    it("is a read-only, permission-declared tool offered to the general controller and Bookkeeping, citing the close workspace", async () => {
      expect(tool().permission).toBe("close_checklist:read");
      expect(AGENT_MODES.GENERAL.readToolNames).toBeNull();
      expect(AGENT_MODES.BOOKKEEPING.readToolNames).toContain("close_status");

      const outcome = await tool().execute(owner, { month: "2026-09" });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const live = await CloseChecklistService.compute(owner, "2026-09");
      expect(outcome.summary).toContain(`${live.progress.percent}% complete`);
      expect(outcome.summary).toContain("1 bank transaction in Everyday Account is unreconciled");
      expect(outcome.summary).toContain("AWAITING A HUMAN SIGN-OFF");
      expect(outcome.citation).toMatchObject({ tool: "close_status", periodLabel: "2026-09", drillDownHref: "/accounting/close/2026-09" });
      // Running the tool changed nothing: still no period row, no lock.
      expect(await withTenant(orgId, (tx) => tx.select().from(fiscalPeriods))).toHaveLength(0);
    });

    it("is refused for a role without close_checklist:read — a real restricted-role actor — exactly as the page would be", async () => {
      for (const role of ["EMPLOYEE", "ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE", "PAYROLL_MANAGER"] as const) {
        const outcome = await tool().execute(actorWithRole(owner, role), { month: "2026-09" });
        expect(outcome.ok, role).toBe(false);
        if (outcome.ok) throw new Error("expected refusal");
        expect(outcome.error).toMatch(/access denied/i);
        expect(outcome.error).toContain("close_checklist:read");
      }
      await expect(CloseChecklistService.compute(actorWithRole(owner, "EMPLOYEE"), "2026-09")).rejects.toThrow(PermissionDeniedError);
    });

    it("a role without payrun:read gets the status with payroll omitted and is told items are hidden", async () => {
      const outcome = await tool().execute(actorWithRole(owner, "MANAGER"), { month: "2026-09" });
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.summary).toMatch(/hidden from this user's role/);
      expect(outcome.summary).not.toMatch(/pay run/i);
    });

    it("validates its argument", async () => {
      expect((await tool().execute(owner, { month: "September" })).ok).toBe(false);
      expect((await tool().execute(owner, { month: "2026-13" })).ok).toBe(false);
    });

    it("end to end with the mocked model: it can report status, and a model attempt to close the period is an unknown tool that changes nothing", async () => {
      const create = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t1", name: "close_status", input: { month: "2026-09" } }] })
        .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t2", name: "close_period", input: { month: "2026-09", lockLevel: "HARD_LOCKED" } }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "September is partly complete; closing is something a person has to do in the app." }] });
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

      const outcome = await FinancialControllerService.ask(owner, "Can you close September for me?");
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("expected ok");
      expect(outcome.citations.map((c) => c.tool)).toEqual(["close_status"]);

      const offered = (create.mock.calls[0]![0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(offered).toContain("close_status");
      expect(offered.filter((n) => /close_period|reopen|lock/i.test(n))).toEqual([]);
      const lastMessages = (create.mock.calls[2]![0] as { messages: Array<{ content: unknown }> }).messages;
      expect(JSON.stringify(lastMessages[lastMessages.length - 1]!.content)).toContain('Unknown tool \\"close_period\\"');
      expect(await withTenant(orgId, (tx) => tx.select().from(fiscalPeriods))).toHaveLength(0);
    });
  });

  describe("critical-action exclusion: fiscal period close/reopen/lock is unreachable by any AI path", () => {
    it("no controller tool (read or write) can close, lock, reopen or sign off; none declares a period:* permission", () => {
      const readTools = buildControllerTools([]);
      const writeTools = buildWriteTools("anything", "model");
      const names = [...readTools.map((t) => t.name), ...writeTools.map((t) => t.name)];
      // The only close-related tool is the read-only status one.
      expect(names.filter((n) => /close|reopen|lock|period|signoff|sign_off/i.test(n))).toEqual(["close_status"]);
      expect(writeTools.every((t) => t.name.startsWith("prepare_draft_"))).toBe(true);
      for (const t of [...readTools, ...writeTools]) {
        expect(t.permission.startsWith("period:"), `${t.name} -> ${t.permission}`).toBe(false);
        expect(t.permission).not.toBe("close_checklist:manage");
      }
      for (const permission of Object.values(WRITE_TOOL_PERMISSIONS)) {
        expect(permission.startsWith("period:")).toBe(false);
        expect(permission).not.toBe("close_checklist:manage");
      }
    });

    it("the auto-execution allowlist cannot contain a period action and refuses to whitelist one, even at autonomy Level 4", async () => {
      expect(AUTO_APPROVABLE_ACTION_TYPES.filter((a) => /PERIOD|CLOSE|LOCK|REOPEN/i.test(a))).toEqual([]);
      expect(EXCLUDED_ACTION_TYPE_EXAMPLES).toContain("FISCAL_PERIOD_CLOSE");
      await AutonomySettingsService.setLevel(owner, 4);
      for (const bogus of ["FISCAL_PERIOD_CLOSE", "FISCAL_PERIOD_REOPEN", "PERIOD_LOCK_OVERRIDE", "PERIOD_CLOSE"]) {
        await expect(AutoApprovedActionsService.setEnabled(owner, bogus, true), bogus).rejects.toThrow(InvalidAutoApprovedActionTypeError);
      }
    });

    it("even an actor typed AI/SYSTEM that carries an OWNER role cannot close, lock, reopen or sign off (humans only)", async () => {
      for (const type of ["AI", "SYSTEM"] as const) {
        const machine: Actor = { ...owner, type };
        await expect(PeriodCloseService.close(machine, "2026-09", { acknowledgeOutstanding: true })).rejects.toThrow(PermissionDeniedError);
        await expect(PeriodCloseService.signOff(machine, "2026-09", "manual.accruals")).rejects.toThrow(PermissionDeniedError);
        await expect(PeriodLockService.raise(machine, "2026-09", "HARD_LOCKED")).rejects.toThrow(PermissionDeniedError);
        await expect(PeriodLockService.reopen(machine, "2026-09", { reason: "A machine trying to reopen a period" })).rejects.toThrow(PermissionDeniedError);
      }
      expect(await withTenant(orgId, (tx) => tx.select().from(fiscalPeriods))).toHaveLength(0);
    });

    it("no role-matrix path gives an AI-oriented role the period permissions (the matrix is the same as the UI's)", () => {
      const holders = (p: Parameters<(typeof ROLE_PERMISSIONS)["OWNER"]["has"]>[0]) => Object.entries(ROLE_PERMISSIONS).filter(([, set]) => set.has(p)).map(([r]) => r);
      expect(holders("period:close")).not.toContain("EMPLOYEE");
      expect(holders("period:reopen_hard").sort()).toEqual(["ADMINISTRATOR", "OWNER"]);
    });
  });

  describe("optional commentary", () => {
    it("is handed only already-computed checklist facts, keeps system-verified and human-signed separate, and returns the model's text", async () => {
      await PeriodCloseService.signOff(owner, "2026-09", "manual.accruals", "done");
      const checklist = await CloseChecklistService.compute(owner, "2026-09");
      const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Two things remain: the bank item and the draft invoice." }] });
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

      expect(await CloseCommentaryService.forChecklist(checklist)).toBe("Two things remain: the bank item and the draft invoice.");
      const request = create.mock.calls[0]![0] as { system: string; messages: Array<{ content: string }> };
      expect(request.system).toMatch(/never calculate/i);
      expect(request.system).toMatch(/NOT verified by the system/);
      expect(request.system).toMatch(/cannot close, lock or change anything/);
      const facts = request.messages[0]!.content;
      expect(facts).toContain("SIGNED OFF BY A PERSON (not system-verified): Accruals reviewed");
      expect(facts).toContain("VERIFIED BY THE SYSTEM from live data");
      expect(facts).toContain(`${checklist.progress.percent}% complete`);
      expect(checklistFacts(checklist).join("\n")).toBe(facts.replace("Here are the already-computed close checklist facts:\n\n", ""));
      // The model was offered no tools at all.
      expect((create.mock.calls[0]![0] as { tools?: unknown }).tools).toBeUndefined();
    });

    it("is omitted (null) with no API key and when the call fails — never an error, never a made-up string", async () => {
      const checklist = await CloseChecklistService.compute(owner, "2026-09");
      delete process.env.ANTHROPIC_API_KEY;
      expect(await CloseCommentaryService.forChecklist(checklist)).toBeNull();
      process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: vi.fn().mockRejectedValue(new Error("network down")) }; } }));
      expect(await CloseCommentaryService.forChecklist(checklist)).toBeNull();
    });
  });
});
