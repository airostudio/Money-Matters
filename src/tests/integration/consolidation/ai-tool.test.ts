import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTestPools, resetDatabase } from "../../helpers/db";
import { createConsolidationWorld, createFullGroup, type ConsolidationWorld } from "../../helpers/consolidation";
import { GroupService } from "@/domain/consolidation/group-service";
import { buildControllerTools } from "@/domain/ai-controller/controller-tools";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";
import { AGENT_MODES } from "@/domain/ai-controller/specialist-agents";
import { FinancialControllerService } from "@/domain/ai-controller/financial-controller-service";
import { AUTO_APPROVABLE_ACTION_TYPES } from "@/domain/ai-controller/auto-execution-policy";
import type { Actor } from "@/domain/permissions/permission-service";
import { db } from "@/db/client";
import { organizations } from "@/db/schema";
import { eq } from "drizzle-orm";

async function scenario() {
  const world = await createConsolidationWorld();
  const group = await createFullGroup(world);
  await GroupService.designateIntercompany(world.groupActor, group.id, {
    organizationId: world.entities.A.organizationId,
    accountId: world.entities.A.accountIds["1500"]!,
    kind: "LOAN_RECEIVABLE",
    counterpartyOrganizationId: world.entities.B.organizationId,
  });
  await GroupService.designateIntercompany(world.groupActor, group.id, {
    organizationId: world.entities.B.organizationId,
    accountId: world.entities.B.accountIds["2500"]!,
    kind: "LOAN_PAYABLE",
    counterpartyOrganizationId: world.entities.A.organizationId,
  });
  return { world, group };
}

const tool = () => {
  const def = buildControllerTools([]).find((t) => t.name === "consolidated_report");
  if (!def) throw new Error("consolidated_report not registered");
  return def;
};

/** The chat happens in organization A, as the user's real Actor there. */
const chatActor = (world: ConsolidationWorld, role: Actor["role"] = "OWNER"): Actor => world.actorIn("A", role);

describe("AI Financial Controller — consolidated_report (read-only, permission parity, no leak)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  const originalKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(async () => {
    await resetDatabase();
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  describe("shape: read-only and outside every write / auto-execution path", () => {
    it("is a read tool offered to the general controller, declares financial_report:read, and no consolidation write tool exists", () => {
      expect(tool().permission).toBe("financial_report:read");
      expect(AGENT_MODES.GENERAL.readToolNames).toBeNull();

      const writeTools = buildWriteTools("anything", "model");
      expect(writeTools.every((t) => t.name.startsWith("prepare_draft_"))).toBe(true);
      const allNames = [...buildControllerTools([]), ...writeTools].map((t) => t.name);
      expect(allNames.filter((n) => /consolidat|adjust|group|intercompany|eliminat|mapping/i.test(n))).toEqual(["consolidated_report"]);
      // Nothing in its schema can name an organization or an account: only a report kind, a group NAME and a date/period.
      expect(Object.keys((tool().inputSchema as { properties: object }).properties).sort()).toEqual(["asOfDate", "group", "period", "report"]);
    });

    it("the auto-execution policy (levels 3/4) is untouched: no consolidation action type is auto-approvable", () => {
      expect([...AUTO_APPROVABLE_ACTION_TYPES].filter((t) => /consolidat|adjust|group|intercompany|eliminat/i.test(t))).toEqual([]);
    });
  });

  describe("results", () => {
    it("reports consolidated figures with the same numbers as the service, and a citation", async () => {
      const { world } = await scenario();
      await world.setUserRole("B", "ACCOUNTANT");
      await world.setUserRole("C", "READ_ONLY");
      await world.removeUser("D");

      const outcome = await tool().execute(chatActor(world), { report: "BALANCE_SHEET", asOfDate: "2026-03-31" });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.summary).toContain("Consolidated Balance Sheet as of 2026-03-31");
      expect(outcome.summary).toContain("CONSOLIDATED 73200.0000"); // assets after eliminating the 10,000 loan
      expect(outcome.summary).toContain("balances");
      expect(outcome.summary).toContain("1 entity excluded — no access");
      expect(outcome.citation).toMatchObject({ tool: "consolidated_report", periodLabel: "as of 2026-03-31" });
      expect(outcome.citation.description).toContain("Test Group");

      const cash = await tool().execute(chatActor(world), { report: "CASH", asOfDate: "2026-03-31" });
      if (!cash.ok) throw new Error("expected ok");
      expect(cash.summary).toContain("Total cash across the included entities: 73200.0000");

      const pl = await tool().execute(chatActor(world), { report: "PROFIT_AND_LOSS", period: { kind: "CUSTOM", from: "2026-01-01", to: "2026-03-31" } });
      if (!pl.ok) throw new Error("expected ok");
      expect(pl.summary).toContain("CONSOLIDATED 6200.0000");
    });

    it("asks which group when there are several and none is named; says so when there are none", async () => {
      const { world } = await scenario();
      await GroupService.create(world.groupActor, { name: "Second Group" });
      const ambiguous = await tool().execute(chatActor(world), { report: "CASH" });
      if (!ambiguous.ok) throw new Error("expected ok");
      expect(ambiguous.summary).toContain("Which entity group?");
      expect(ambiguous.summary).toContain("Test Group");
      expect(ambiguous.summary).toContain("Second Group");

      const named = await tool().execute(chatActor(world), { report: "CASH", group: "second group", asOfDate: "2026-03-31" });
      if (!named.ok) throw new Error("expected ok");
      expect(named.summary).toContain("Entity group \"Second Group\"");

      const stranger = await createConsolidationWorld({ seedLedgers: false });
      const none = await tool().execute(stranger.actorIn("A", "OWNER"), { report: "CASH" });
      if (!none.ok) throw new Error("expected ok");
      expect(none.summary).toContain("no entity groups");
    });

    it("refuses mixed base currencies with the specific message", async () => {
      const { world } = await scenario();
      await world.removeUser("D");
      await db.update(organizations).set({ baseCurrency: "NZD" }).where(eq(organizations.id, world.entities.B.organizationId));
      const outcome = await tool().execute(chatActor(world), { report: "CASH", asOfDate: "2026-03-31" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toContain("different base currencies: AUD, NZD");
      expect(outcome.error).toContain("not yet supported");
    });
  });

  describe("NO LEAK: data from unauthorised entities never reaches the model", () => {
    it("with a real restricted-role actor in C (EMPLOYEE) and no membership in D, neither entity's numbers or names are in the tool output", async () => {
      const { world } = await scenario();
      await world.setUserRole("B", "ACCOUNTANT");
      await world.setUserRole("C", "EMPLOYEE"); // no financial_report:read
      await world.removeUser("D"); // not a member

      for (const input of [
        { report: "CASH", asOfDate: "2026-03-31" },
        { report: "BALANCE_SHEET", asOfDate: "2026-03-31" },
        { report: "PROFIT_AND_LOSS", period: { kind: "CUSTOM", from: "2026-01-01", to: "2026-03-31" } },
      ]) {
        const outcome = await tool().execute(chatActor(world), input);
        if (!outcome.ok) throw new Error("expected ok");
        const text = JSON.stringify(outcome);
        expect(outcome.summary).toContain("2 entities excluded — no access");
        // D: 99,999.00 capital; C: 7,000.00 capital. Neither figure, nor any name/slug/id of either entity.
        expect(text).not.toContain("99999");
        // (In the P&L, A's 5,000 + B's 2,000 revenue legitimately totals 7,000, so C's figure is only checkable elsewhere.)
        if (input.report !== "PROFIT_AND_LOSS") expect(text).not.toContain("7000.0000");
        for (const key of ["C", "D"] as const) {
          expect(text).not.toContain(world.entities[key].name);
          expect(text).not.toContain(world.entities[key].slug);
          expect(text).not.toContain(world.entities[key].organizationId);
        }
        // Only A and B are consolidated.
        expect(text).toContain(world.entities.A.name);
        expect(text).toContain(world.entities.B.name);
      }
      const cash = await tool().execute(chatActor(world), { report: "CASH", asOfDate: "2026-03-31" });
      if (!cash.ok) throw new Error("expected ok");
      expect(cash.summary).toContain("66200.0000"); // 55,000 + 11,200 only
    });

    it("a user restricted everywhere except A sees only A, with every other entity reported as a count", async () => {
      const { world } = await scenario();
      await world.setUserRole("B", "EMPLOYEE");
      await world.setUserRole("C", "EMPLOYEE");
      await world.removeUser("D");
      const outcome = await tool().execute(chatActor(world), { report: "CASH", asOfDate: "2026-03-31" });
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.summary).toContain("3 entities excluded — no access");
      expect(outcome.summary).toContain("Total cash across the included entities: 55000.0000");
      expect(outcome.summary).not.toContain("11200.0000");
      expect(outcome.summary).not.toContain(world.entities.B.name);
    });

    it("is refused outright when the user's role in the chat organization cannot read reports", async () => {
      const { world } = await scenario();
      // The chat Actor carries an EMPLOYEE role in A (a real restricted role): the tool applies the same gate as every report tool.
      const outcome = await tool().execute(chatActor(world, "EMPLOYEE"), { report: "CASH" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toMatch(/access denied/i);
      expect(outcome.error).toContain("financial_report:read");
    });

    it("end to end with the mocked model: every message sent back to the model is free of unauthorised data, and a write attempt is an unknown tool", async () => {
      const { world } = await scenario();
      await world.setUserRole("C", "EMPLOYEE");
      await world.removeUser("D");

      const create = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t1", name: "consolidated_report", input: { report: "CASH", asOfDate: "2026-03-31" } }] })
        .mockResolvedValueOnce({ content: [{ type: "tool_use", id: "t2", name: "create_consolidation_adjustment", input: { amount: "100" } }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "Group cash across the entities you can access is 66,200.00; 2 entities were excluded." }] });
      vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

      const outcome = await FinancialControllerService.ask(chatActor(world), "What is our group's total cash?");
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("expected ok");
      expect(outcome.citations.map((c) => c.tool)).toEqual(["consolidated_report"]);

      // The model was offered the read tool and no consolidation write tool.
      const offered = (create.mock.calls[0]![0] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      expect(offered).toContain("consolidated_report");
      expect(offered.filter((n) => /adjust|mapping|intercompany|eliminat/i.test(n))).toEqual([]);

      // Everything the model was ever shown (all request payloads) and its final answer path: no unauthorised data.
      const everything = JSON.stringify(create.mock.calls.map((c) => c[0])) + outcome.answer;
      expect(everything).not.toContain("99999");
      expect(everything).not.toContain(world.entities.D.name);
      expect(everything).not.toContain(world.entities.D.slug);
      expect(everything).not.toContain(world.entities.C.name);
      expect(everything).not.toContain("7000.0000");
      expect(everything).toContain("66200.0000"); // the authorised total reached the model
      expect(everything).toContain("2 entities excluded — no access");
      expect(everything).toContain('Unknown tool \\"create_consolidation_adjustment\\"');
    });
  });
});
