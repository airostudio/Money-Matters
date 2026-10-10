import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { invoices } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { FinancialControllerService } from "@/domain/ai-controller/financial-controller-service";
import { AutonomySettingsService } from "@/domain/ai-controller/autonomy";
import { AIDraftProposalService } from "@/domain/ai-controller/draft-proposal-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * The slice's end-to-end proof, mirroring the task's smoke-test script
 * exactly but over the real test database with a mocked Anthropic client
 * (never a real network call — same discipline as every other AI
 * integration here): an org at Level 2, a permitted user asks the
 * Controller to draft an invoice, confirms the proposal through the
 * SEPARATE confirmation path, and a real DRAFT invoice appears — and an org
 * left at the default Level 0 never even gets a write tool offered for the
 * identical question.
 */
describe("Controller conversation -> draft proposal -> explicit confirmation (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;
  let fixtures: Awaited<ReturnType<typeof createSalesFixtures>>;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("ai-draft-flow");
    owner = org.owner;
    orgId = org.organizationId;
    fixtures = await createSalesFixtures(owner, org.baseCurrency);
    process.env.ANTHROPIC_API_KEY = "fake-key-for-tests";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  function mockPrepareInvoiceCall(finalText: string) {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi
            .fn()
            .mockResolvedValueOnce({
              content: [
                {
                  type: "tool_use",
                  id: "t1",
                  name: "prepare_draft_invoice",
                  input: {
                    customerName: "Acme",
                    lines: [{ description: "August consulting", unitPrice: "3500.00", accountName: "Sales Revenue" }],
                  },
                },
              ],
            })
            .mockResolvedValueOnce({ content: [{ type: "text", text: finalText }] }),
        };
      },
    }));
  }

  it("Level 2: the Controller prepares a proposal, and ONLY the separate confirm step creates a real DRAFT invoice", async () => {
    await AutonomySettingsService.setLevel(owner, 2);
    mockPrepareInvoiceCall("I've prepared a draft invoice to Acme for $3500.00 — please review and confirm.");

    const outcome = await FinancialControllerService.ask(owner, "Invoice Acme $3,500 for August consulting.");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");

    expect(outcome.proposals).toHaveLength(1);
    const proposal = outcome.proposals[0]!;
    expect(proposal.preview.counterpartyName).toBe("Acme Pty Ltd");
    expect(proposal.preview.total).toBe("3500.0000");

    // The conversation turn alone — even though the model called the write
    // tool and got back a proposal — must not have created anything yet.
    const beforeConfirm = await withTenant(orgId, (tx) => tx.select().from(invoices));
    expect(beforeConfirm).toHaveLength(0);

    const confirmed = await AIDraftProposalService.confirm(owner, proposal.id);
    expect(confirmed.type).toBe("INVOICE");

    const afterConfirm = await withTenant(orgId, (tx) => tx.select().from(invoices));
    expect(afterConfirm).toHaveLength(1);
    expect(afterConfirm[0]!.status).toBe("DRAFT");
    expect(afterConfirm[0]!.total).toBe("3500.0000");
  });

  it("Level 0 (default): the identical request never has a write tool offered, and the Controller cannot prepare anything", async () => {
    // No AutonomySettingsService.setLevel call — this org is at its default.
    const create = vi.fn().mockResolvedValueOnce({
      content: [{ type: "text", text: "I can look up invoices, but I can't create or draft one for you here." }],
    });
    vi.doMock("@anthropic-ai/sdk", () => ({ default: class { messages = { create } } }));

    const outcome = await FinancialControllerService.ask(owner, "Invoice Acme $3,500 for August consulting.");
    expect(outcome.status).toBe("ok");
    const toolNames = (create.mock.calls[0]![0].tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("prepare_draft_invoice");

    if (outcome.status === "ok") {
      expect(outcome.proposals).toHaveLength(0);
    }

    const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
    expect(invoiceRows).toHaveLength(0);
  });

  it("a restricted-role user who sees someone else's proposal is refused at the real confirmation step", async () => {
    await AutonomySettingsService.setLevel(owner, 2);
    mockPrepareInvoiceCall("Here's a draft for your review.");

    const outcome = await FinancialControllerService.ask(owner, "Invoice Acme $3,500 for August consulting.");
    if (outcome.status !== "ok") throw new Error("expected ok");
    const proposal = outcome.proposals[0]!;

    const restricted = await addTestMember(owner, "READ_ONLY", "Restricted");
    await expect(AIDraftProposalService.confirm(restricted, proposal.id)).rejects.toThrow();

    const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
    expect(invoiceRows).toHaveLength(0);
  });

  it("an EMPLOYEE actor at Level 2 is refused inside the tool itself (same permission discipline as Slice 1's read tools) — the autonomy gate alone is never the only check", async () => {
    await AutonomySettingsService.setLevel(owner, 2);
    const employee = actorWithRole(owner, "EMPLOYEE");
    mockPrepareInvoiceCall("I'm not able to prepare that draft — your role doesn't have permission to create invoices.");

    const outcome = await FinancialControllerService.ask(employee, "Invoice Acme $3,500 for August consulting.");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("expected ok");
    // The tool IS offered at Level 2 (the autonomy gate passed) but the
    // model's call to it is refused by the tool's own permission check —
    // no proposal is ever produced, let alone a draft invoice.
    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.answer.toLowerCase()).toMatch(/access denied|permission|not able/);

    const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
    expect(invoiceRows).toHaveLength(0);
  });
});
