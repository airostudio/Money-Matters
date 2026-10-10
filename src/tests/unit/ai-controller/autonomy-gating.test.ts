import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Master spec §8's autonomy gate, Phase 6 Slice 2: a write-capable tool
 * (`prepare_draft_invoice`/`prepare_draft_bill`/`prepare_draft_journal_entry`)
 * must never even be offered to the model unless the organization's
 * autonomy level is >= 2 — checked BEFORE the tool list is built, not only
 * when a tool is called. `AutonomySettingsService.getLevel` is mocked here
 * (no real database) so this is a pure gating-logic test; the real DB-backed
 * proof that Level 2 actually creates a DRAFT only after a separate human
 * confirmation lives in
 * `src/tests/integration/ai-controller/write-tools.test.ts`.
 */
describe("FinancialControllerService.ask — autonomy-level tool gating", () => {
  const actor = {
    userId: "00000000-0000-0000-0000-000000000001",
    organizationId: "00000000-0000-0000-0000-000000000002",
    role: "OWNER" as const,
  };
  const originalKey = process.env.ANTHROPIC_API_KEY;

  function mockAutonomy(level: number) {
    vi.doMock("@/domain/ai-controller/autonomy", () => ({
      AutonomySettingsService: { getLevel: vi.fn().mockResolvedValue(level) },
    }));
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
    vi.doMock("@/domain/dimensions/dimension-service", () => ({
      DimensionService: { listActive: vi.fn().mockResolvedValue([]) },
    }));
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
    vi.doUnmock("@/domain/dimensions/dimension-service");
    vi.doUnmock("@/domain/ai-controller/autonomy");
    vi.resetModules();
  });

  it("never includes a prepare_draft_* tool in the Anthropic call when the org is at the default Level 0", async () => {
    mockAutonomy(0);
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Sure, here's what I can tell you." }] });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    const outcome = await FinancialControllerService.ask(actor, "Please invoice Acme $500 for consulting.");
    expect(outcome.status).toBe("ok");
    expect(create).toHaveBeenCalledTimes(1);
    const toolNames = (create.mock.calls[0]![0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("prepare_draft_invoice");
    expect(toolNames).not.toContain("prepare_draft_bill");
    expect(toolNames).not.toContain("prepare_draft_journal_entry");
  });

  it("still excludes write tools at Level 1 (Suggest is still information-only)", async () => {
    mockAutonomy(1);
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Sure." }] });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    await FinancialControllerService.ask(actor, "Invoice Acme $500.");
    const toolNames = (create.mock.calls[0]![0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("prepare_draft_invoice");
  });

  it("offers all three prepare_draft_* tools once the org is at Level 2", async () => {
    mockAutonomy(2);
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Sure." }] });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    await FinancialControllerService.ask(actor, "Invoice Acme $500.");
    const toolNames = (create.mock.calls[0]![0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("prepare_draft_invoice");
    expect(toolNames).toContain("prepare_draft_bill");
    expect(toolNames).toContain("prepare_draft_journal_entry");
  });

  it("a Level-2 AR agent mode offers prepare_draft_invoice but never prepare_draft_bill or read tools outside its scope", async () => {
    mockAutonomy(2);
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Sure." }] });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    await FinancialControllerService.ask(actor, "Invoice Acme $500.", [], "AR");
    const toolNames = (create.mock.calls[0]![0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).toContain("prepare_draft_invoice");
    expect(toolNames).not.toContain("prepare_draft_bill");
    expect(toolNames).not.toContain("trial_balance");
    expect(toolNames).not.toContain("balance_sheet");
  });

  it("the FP&A agent mode never offers any write tool, even at Level 2", async () => {
    mockAutonomy(2);
    const create = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "Sure." }] });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    await FinancialControllerService.ask(actor, "How's profitability trending?", [], "FPA");
    const toolNames = (create.mock.calls[0]![0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("prepare_draft_invoice");
    expect(toolNames).not.toContain("prepare_draft_bill");
    expect(toolNames).not.toContain("prepare_draft_journal_entry");
    expect(toolNames).toContain("profit_and_loss");
  });
});
