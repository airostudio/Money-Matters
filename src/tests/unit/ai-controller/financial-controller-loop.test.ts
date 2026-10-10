import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pure orchestration-logic tests for `FinancialControllerService.ask`'s
 * tool-call loop: the round cap, malformed tool-call-argument rejection, and
 * the "no tool called but the answer looks like a figure" guard. No real
 * database is used — `DimensionService.listActive` is mocked to an empty
 * list (the loop always calls it once per turn to build `run_report`'s
 * dimension hint) and `@anthropic-ai/sdk` is mocked, the same pattern every
 * other AI integration's tests in this codebase use. Tests that need a tool
 * to actually run against real data belong in
 * `src/tests/integration/ai-controller/`.
 */
describe("FinancialControllerService.ask — orchestration loop", () => {
  const actor = {
    userId: "00000000-0000-0000-0000-000000000001",
    organizationId: "00000000-0000-0000-0000-000000000002",
    role: "OWNER" as const,
  };
  const originalKey = process.env.ANTHROPIC_API_KEY;

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
    vi.resetModules();
  });

  it("is unavailable with no ANTHROPIC_API_KEY set, with no network call attempted", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");
    const outcome = await FinancialControllerService.ask(actor, "What's our cash position?");
    expect(outcome.status).toBe("unavailable");
  });

  it("rejects an empty question without calling the AI at all", async () => {
    const create = vi.fn();
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");
    const outcome = await FinancialControllerService.ask(actor, "   ");
    expect(outcome.status).toBe("unavailable");
    expect(create).not.toHaveBeenCalled();
  });

  it("degrades to 'unavailable' (never a crash) when the AI call fails", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("network down")) };
      },
    }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");
    const outcome = await FinancialControllerService.ask(actor, "What's our cash position?");
    expect(outcome.status).toBe("unavailable");
  });

  it("caps the number of tool-call rounds rather than looping forever", async () => {
    // The model asks for a tool that doesn't exist, every single round —
    // simulating a model that never converges on a final answer.
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "not_a_real_tool", input: {} }],
    });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    const outcome = await FinancialControllerService.ask(actor, "Tell me everything");
    expect(outcome.status).toBe("ok");
    // 5 rounds total, the 5th forced to `tool_choice: none` — exactly 5 calls, never more.
    expect(create).toHaveBeenCalledTimes(5);
    if (outcome.status === "ok") {
      expect(outcome.answer).toMatch(/stop|more specific/i);
    }
  });

  it("rejects malformed tool-call arguments without executing the tool or crashing", async () => {
    const create = vi
      .fn()
      // Round 1: calls a real tool with an argument that fails its schema (asOfDate must be YYYY-MM-DD).
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "t1", name: "trial_balance", input: { asOfDate: 12345 } }],
      })
      // Round 2: the model acknowledges the tool_result error and answers without data.
      .mockResolvedValueOnce({ content: [{ type: "text", text: "I wasn't able to look that up." }] });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    const outcome = await FinancialControllerService.ask(actor, "What's our trial balance?");
    expect(outcome.status).toBe("ok");
    expect(create).toHaveBeenCalledTimes(2);
    // The second call's tool_result for the malformed first call must carry an error, not a crash.
    const secondCallArgs = create.mock.calls[1]![0];
    const toolResultMessage = secondCallArgs.messages.find((m: any) => m.role === "user" && Array.isArray(m.content));
    const toolResult = toolResultMessage.content.find((c: any) => c.type === "tool_result");
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/invalid arguments/i);
  });

  it("refuses an uncited numeric-looking answer when no tool was ever called (never trust a free-hallucinated figure)", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Your net profit last month was $12,345.67." }],
    });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    const outcome = await FinancialControllerService.ask(actor, "What was our net profit?");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.answer).not.toContain("12,345.67");
      expect(outcome.answer.toLowerCase()).toMatch(/rephrase|specific|look it up/);
    }
  });

  it("passes through a non-numeric answer unmodified when no tool was called (the uncited-figure guard is specific to money-shaped text)", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Could you tell me which period you mean — this month or last month?" }],
    });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));
    const { FinancialControllerService } = await import("@/domain/ai-controller/financial-controller-service");

    const outcome = await FinancialControllerService.ask(actor, "What was our net profit?");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.answer).toContain("which period you mean");
    }
  });
});
