import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createSalesFixtures } from "../../helpers/sales";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { auditLogs, invoices, bills, journalEntries } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { buildWriteTools } from "@/domain/ai-controller/write-tools";
import { AIDraftProposalService, AutonomyLevelTooLowError, ProposalNotFoundError } from "@/domain/ai-controller/draft-proposal-service";
import { AutonomySettingsService, InvalidAutonomyLevelError } from "@/domain/ai-controller/autonomy";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Real-database proof for Phase 6 Slice 2's write-capable Controller tools
 * and their proposal/confirmation split — the slice's single most
 * safety-critical guarantee: a tool call alone never creates anything, only
 * a separate, explicit confirmation does, under the real permission check.
 */
describe("AI Controller write tools + draft proposal confirmation (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let orgId: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("ai-write-tools");
    owner = org.owner;
    orgId = org.organizationId;
    // Fixtures create the chart of accounts/contacts the write tools resolve
    // against by name ("Sales Revenue", "Accounts Receivable", "Bunnings
    // Trade Pty Ltd", "Office Supplies", ...) — their returned ids aren't
    // needed directly since every test below goes through the tool's own
    // name-based resolution, exactly like a real conversation would.
    await createSalesFixtures(owner, org.baseCurrency);
    await createPurchasesFixtures(owner, org.baseCurrency);
  });

  const tool = (name: string) => {
    const def = buildWriteTools("test question", "test-model").find((t) => t.name === name);
    if (!def) throw new Error(`tool ${name} not registered`);
    return def;
  };

  describe("AutonomySettingsService", () => {
    it("defaults every organization to Level 0", async () => {
      expect(await AutonomySettingsService.getLevel(orgId)).toBe(0);
    });

    it("lets an OWNER raise the level to 2", async () => {
      await AutonomySettingsService.setLevel(owner, 2);
      expect(await AutonomySettingsService.getLevel(orgId)).toBe(2);
    });

    it("refuses a non-owner/administrator trying to change it", async () => {
      const bookkeeper = actorWithRole(owner, "BOOKKEEPER");
      await expect(AutonomySettingsService.setLevel(bookkeeper, 2)).rejects.toThrow(PermissionDeniedError);
      expect(await AutonomySettingsService.getLevel(orgId)).toBe(0);
    });

    it("rejects Level 3/4 — not implemented this slice", async () => {
      await expect(AutonomySettingsService.setLevel(owner, 3)).rejects.toThrow(InvalidAutonomyLevelError);
      await expect(AutonomySettingsService.setLevel(owner, 4)).rejects.toThrow(InvalidAutonomyLevelError);
      expect(await AutonomySettingsService.getLevel(orgId)).toBe(0);
    });
  });

  describe("prepare_draft_invoice", () => {
    it("resolves the customer/account and stores a PENDING proposal — never creates an invoice", async () => {
      const outcome = await tool("prepare_draft_invoice").execute(owner, {
        customerName: "Acme",
        lines: [{ description: "August consulting", unitPrice: "3500.00", accountName: "Sales Revenue" }],
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.proposal).toBeDefined();
      expect(outcome.proposal!.preview.headline).toContain("3500.00");
      expect(outcome.proposal!.preview.counterpartyName).toBe("Acme Pty Ltd");

      // The single most important assertion in this slice: a tool call alone
      // creates zero invoice rows.
      const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
      expect(invoiceRows).toHaveLength(0);

      const stored = await AIDraftProposalService.get(owner, outcome.proposal!.id);
      expect(stored?.status).toBe("PENDING");
    });

    it("is refused for a role without customer_invoice:manage, without storing a proposal", async () => {
      const readOnly = actorWithRole(owner, "READ_ONLY");
      const outcome = await tool("prepare_draft_invoice").execute(readOnly, {
        customerName: "Acme",
        lines: [{ description: "Work", unitPrice: "100.00", accountName: "Sales Revenue" }],
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toMatch(/access denied/i);
      expect(outcome.error).toContain("customer_invoice:manage");
    });

    it("never invents a customer id — an unmatched name is a hard failure, not a guess", async () => {
      const outcome = await tool("prepare_draft_invoice").execute(owner, {
        customerName: "Totally Nonexistent Customer",
        lines: [{ description: "Work", unitPrice: "100.00", accountName: "Sales Revenue" }],
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toMatch(/no customer found/i);
    });

    it("asks for clarification rather than guessing when a revenue account is ambiguous", async () => {
      const outcome = await tool("prepare_draft_invoice").execute(owner, {
        customerName: "Acme",
        lines: [{ description: "Work", unitPrice: "100.00" }], // no accountName — two revenue accounts exist
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toMatch(/please specify which revenue account/i);
    });
  });

  describe("prepare_draft_bill", () => {
    it("resolves the supplier/account and stores a PENDING proposal — never creates a bill", async () => {
      const outcome = await tool("prepare_draft_bill").execute(owner, {
        supplierName: "Bunnings",
        lines: [{ description: "Stationery", unitPrice: "80.00", accountName: "Office Supplies" }],
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      expect(outcome.proposal).toBeDefined();
      expect(outcome.proposal!.preview.counterpartyName).toBe("Bunnings Trade Pty Ltd");

      const billRows = await withTenant(orgId, (tx) => tx.select().from(bills));
      expect(billRows).toHaveLength(0);
    });

    it("is refused for a role without supplier_bill:manage", async () => {
      const readOnly = actorWithRole(owner, "READ_ONLY");
      const outcome = await tool("prepare_draft_bill").execute(readOnly, {
        supplierName: "Bunnings",
        lines: [{ description: "Work", unitPrice: "100.00", accountName: "Office Supplies" }],
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toMatch(/access denied/i);
      expect(outcome.error).toContain("supplier_bill:manage");
    });
  });

  describe("prepare_draft_journal_entry", () => {
    it("stores a PENDING proposal for a balanced entry — never posts/creates anything", async () => {
      const outcome = await tool("prepare_draft_journal_entry").execute(owner, {
        memo: "Opening adjustment",
        lines: [
          { accountName: "Sales Revenue", credit: "100.00" },
          { accountName: "Accounts Receivable", debit: "100.00" },
        ],
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error("expected ok");
      const journalRows = await withTenant(orgId, (tx) => tx.select().from(journalEntries));
      expect(journalRows).toHaveLength(0);
    });

    it("refuses an unbalanced entry rather than storing a proposal", async () => {
      const outcome = await tool("prepare_draft_journal_entry").execute(owner, {
        lines: [
          { accountName: "Sales Revenue", credit: "100.00" },
          { accountName: "Accounts Receivable", debit: "50.00" },
        ],
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toMatch(/does not balance/i);
    });

    it("is refused for a role without journal:post", async () => {
      const readOnly = actorWithRole(owner, "READ_ONLY");
      const outcome = await tool("prepare_draft_journal_entry").execute(readOnly, {
        lines: [
          { accountName: "Sales Revenue", credit: "100.00" },
          { accountName: "Accounts Receivable", debit: "100.00" },
        ],
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("expected refusal");
      expect(outcome.error).toContain("journal:post");
    });
  });

  describe("AIDraftProposalService.confirm", () => {
    beforeEach(async () => {
      await AutonomySettingsService.setLevel(owner, 2);
    });

    it("creates a real DRAFT invoice via the real InvoiceService.create, audited with both the AI proposal and the confirming human", async () => {
      const prepared = await tool("prepare_draft_invoice").execute(owner, {
        customerName: "Acme",
        lines: [{ description: "August consulting", unitPrice: "3500.00", accountName: "Sales Revenue" }],
      });
      if (!prepared.ok || !prepared.proposal) throw new Error("expected a proposal");

      const result = await AIDraftProposalService.confirm(owner, prepared.proposal.id);
      expect(result.type).toBe("INVOICE");

      const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
      expect(invoiceRows).toHaveLength(1);
      expect(invoiceRows[0]!.id).toBe(result.resultEntityId);
      expect(invoiceRows[0]!.status).toBe("DRAFT");
      expect(invoiceRows[0]!.total).toBe("3500.0000");

      const stored = await AIDraftProposalService.get(owner, prepared.proposal.id);
      expect(stored?.status).toBe("CONFIRMED");

      const proposalAudit = await withTenant(orgId, (tx) =>
        tx.select().from(auditLogs).where(and(eq(auditLogs.entityType, "AIDraftProposal"), eq(auditLogs.entityId, prepared.proposal!.id))),
      );
      const proposedRow = proposalAudit.find((r) => r.action === "ai_controller.draft_proposed");
      const confirmedRow = proposalAudit.find((r) => r.action === "ai_controller.draft_confirmed");
      expect(proposedRow?.actorType).toBe("AI");
      expect(confirmedRow?.actorType).toBe("HUMAN");
      expect(confirmedRow?.actorUserId).toBe(owner.userId);
      expect((confirmedRow?.metadata as any)?.confirmedByUserId).toBe(owner.userId);

      const invoiceAudit = await withTenant(orgId, (tx) =>
        tx.select().from(auditLogs).where(and(eq(auditLogs.entityType, "Invoice"), eq(auditLogs.entityId, result.resultEntityId))),
      );
      expect(invoiceAudit.some((r) => r.action === "invoice.draft_created" && r.actorType === "HUMAN")).toBe(true);
    });

    it("creates a real DRAFT bill via the real BillService.create", async () => {
      const prepared = await tool("prepare_draft_bill").execute(owner, {
        supplierName: "Bunnings",
        lines: [{ description: "Supplies", unitPrice: "80.00", accountName: "Office Supplies" }],
      });
      if (!prepared.ok || !prepared.proposal) throw new Error(`expected a proposal: ${JSON.stringify(prepared)}`);

      const result = await AIDraftProposalService.confirm(owner, prepared.proposal.id);
      const billRows = await withTenant(orgId, (tx) => tx.select().from(bills));
      expect(billRows).toHaveLength(1);
      expect(billRows[0]!.status).toBe("DRAFT");
      expect(result.resultEntityId).toBe(billRows[0]!.id);
    });

    it("creates a real DRAFT journal entry via the real PostingService.createDraft", async () => {
      const prepared = await tool("prepare_draft_journal_entry").execute(owner, {
        lines: [
          { accountName: "Sales Revenue", credit: "100.00" },
          { accountName: "Accounts Receivable", debit: "100.00" },
        ],
      });
      if (!prepared.ok || !prepared.proposal) throw new Error("expected a proposal");

      await AIDraftProposalService.confirm(owner, prepared.proposal.id);
      const journalRows = await withTenant(orgId, (tx) => tx.select().from(journalEntries));
      expect(journalRows).toHaveLength(1);
      expect(journalRows[0]!.status).toBe("DRAFT");
    });

    it("refuses to confirm when the org's autonomy level has since been lowered back below 2", async () => {
      const prepared = await tool("prepare_draft_invoice").execute(owner, {
        customerName: "Acme",
        lines: [{ description: "Work", unitPrice: "100.00", accountName: "Sales Revenue" }],
      });
      if (!prepared.ok || !prepared.proposal) throw new Error("expected a proposal");

      await AutonomySettingsService.setLevel(owner, 0);
      await expect(AIDraftProposalService.confirm(owner, prepared.proposal.id)).rejects.toThrow(AutonomyLevelTooLowError);

      const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
      expect(invoiceRows).toHaveLength(0);
    });

    it("refuses to confirm a nonexistent/foreign proposal id", async () => {
      await expect(AIDraftProposalService.confirm(owner, "00000000-0000-0000-0000-000000000099")).rejects.toThrow(ProposalNotFoundError);
    });

    it("is refused at the real creation step for a restricted-role user confirming someone else's proposal, even though the proposal itself exists", async () => {
      const prepared = await tool("prepare_draft_invoice").execute(owner, {
        customerName: "Acme",
        lines: [{ description: "Work", unitPrice: "100.00", accountName: "Sales Revenue" }],
      });
      if (!prepared.ok || !prepared.proposal) throw new Error("expected a proposal");

      const restrictedMember = await addTestMember(owner, "READ_ONLY", "Restricted");
      // The restricted member CAN see the proposal exists (e.g. it was shared with them) —
      // but confirming it must still be refused at the real InvoiceService.create permission check.
      const visible = await AIDraftProposalService.get(restrictedMember, prepared.proposal.id);
      expect(visible?.status).toBe("PENDING");

      await expect(AIDraftProposalService.confirm(restrictedMember, prepared.proposal.id)).rejects.toThrow(PermissionDeniedError);

      const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
      expect(invoiceRows).toHaveLength(0);
      const stored = await AIDraftProposalService.get(owner, prepared.proposal.id);
      expect(stored?.status).toBe("PENDING");
    });

    it("dismiss() marks a proposal DISMISSED and it can no longer be confirmed", async () => {
      const prepared = await tool("prepare_draft_invoice").execute(owner, {
        customerName: "Acme",
        lines: [{ description: "Work", unitPrice: "100.00", accountName: "Sales Revenue" }],
      });
      if (!prepared.ok || !prepared.proposal) throw new Error("expected a proposal");

      await AIDraftProposalService.dismiss(owner, prepared.proposal.id);
      const stored = await AIDraftProposalService.get(owner, prepared.proposal.id);
      expect(stored?.status).toBe("DISMISSED");

      await expect(AIDraftProposalService.confirm(owner, prepared.proposal.id)).rejects.toThrow();
      const invoiceRows = await withTenant(orgId, (tx) => tx.select().from(invoices));
      expect(invoiceRows).toHaveLength(0);
    });
  });
});
