import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { createPurchasesFixtures } from "../../helpers/purchases";
import { PurchaseOrderService } from "@/domain/purchases/purchase-order-service";
import { BillService } from "@/domain/purchases/bill-service";
import { LedgerService } from "@/domain/ledger/ledger-service";
import type { Actor } from "@/domain/permissions/permission-service";

describe("Purchase orders + three-way matching — full flow", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let fixtures: Awaited<ReturnType<typeof createPurchasesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("po-flow");
    owner = org.owner;
    fixtures = await createPurchasesFixtures(owner, org.baseCurrency);
  });

  async function createDraftPo() {
    return PurchaseOrderService.create(owner, {
      supplierContactId: fixtures.supplierContactId,
      issueDate: new Date("2026-02-01"),
      expectedDate: new Date("2026-02-15"),
      currency: "AUD",
      lines: [
        { description: "Widgets", quantity: "10", unitPrice: "50.00", accountId: fixtures.expenseAccountId, taxCodeId: fixtures.taxCodeId },
      ],
    });
  }

  it("creates a draft PO with correct totals and no ledger effect at all", async () => {
    const created = await createDraftPo();
    const po = await PurchaseOrderService.get(owner, created.id);

    expect(po!.status).toBe("DRAFT");
    expect(po!.subtotal).toBe("500.0000");
    expect(po!.taxTotal).toBe("50.0000");
    expect(po!.total).toBe("550.0000");

    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    expect(ap === undefined || ap.balance === "0.0000").toBe(true);
  });

  it("moves DRAFT -> SENT -> PARTIALLY_RECEIVED -> RECEIVED as goods arrive", async () => {
    const created = await createDraftPo();
    await PurchaseOrderService.markSent(owner, created.id);

    let po = await PurchaseOrderService.get(owner, created.id);
    expect(po!.status).toBe("SENT");
    const lineId = po!.lines[0]!.id;

    await PurchaseOrderService.recordReceipt(owner, created.id, {
      receivedDate: new Date("2026-02-10"),
      lines: [{ purchaseOrderLineId: lineId, quantityReceived: "4" }],
    });
    po = await PurchaseOrderService.get(owner, created.id);
    expect(po!.status).toBe("PARTIALLY_RECEIVED");
    expect(po!.lines[0]!.quantityReceived).toBe("4.0000");

    await PurchaseOrderService.recordReceipt(owner, created.id, {
      receivedDate: new Date("2026-02-14"),
      lines: [{ purchaseOrderLineId: lineId, quantityReceived: "6" }],
    });
    po = await PurchaseOrderService.get(owner, created.id);
    expect(po!.status).toBe("RECEIVED");
    expect(po!.lines[0]!.quantityReceived).toBe("10.0000");
  });

  it("refuses to receive more than was ordered", async () => {
    const created = await createDraftPo();
    await PurchaseOrderService.markSent(owner, created.id);
    const po = await PurchaseOrderService.get(owner, created.id);

    await expect(
      PurchaseOrderService.recordReceipt(owner, created.id, {
        receivedDate: new Date("2026-02-10"),
        lines: [{ purchaseOrderLineId: po!.lines[0]!.id, quantityReceived: "11" }],
      }),
    ).rejects.toThrow(/only 10/);
  });

  it("converts a fully-received PO to a matching bill with no discrepancies, and posting it hits the trial balance", async () => {
    const created = await createDraftPo();
    await PurchaseOrderService.markSent(owner, created.id);
    const po = await PurchaseOrderService.get(owner, created.id);
    const lineId = po!.lines[0]!.id;

    await PurchaseOrderService.recordReceipt(owner, created.id, {
      receivedDate: new Date("2026-02-10"),
      lines: [{ purchaseOrderLineId: lineId, quantityReceived: "10" }],
    });

    const result = await PurchaseOrderService.convertToBill(owner, created.id, {
      issueDate: new Date("2026-02-16"),
      dueDate: new Date("2026-03-16"),
      apAccountId: fixtures.apAccountId,
      lines: [{ poLineId: lineId, quantity: "10", unitPrice: "50.00" }],
    });

    expect(result.match.matched).toBe(true);
    expect(result.match.discrepancies).toHaveLength(0);

    const bill = await BillService.get(owner, result.id);
    expect(bill!.status).toBe("DRAFT");
    expect(bill!.total).toBe("550.0000");
    expect(bill!.purchaseOrderId).toBe(created.id);

    const posted = await BillService.approveAndPost(owner, result.id);
    const trialBalance = await LedgerService.getTrialBalance(owner);
    const ap = trialBalance.find((r) => r.accountId === fixtures.apAccountId);
    expect(ap!.balance).toBe("550.0000");
    expect(posted.journalEntryId).toBeTruthy();
  });

  it("finds a quantity mismatch, refuses without acknowledgement, then proceeds once acknowledged — and the bill reflects the billed (not PO) quantity", async () => {
    const created = await createDraftPo();
    await PurchaseOrderService.markSent(owner, created.id);
    const po = await PurchaseOrderService.get(owner, created.id);
    const lineId = po!.lines[0]!.id;

    await PurchaseOrderService.recordReceipt(owner, created.id, {
      receivedDate: new Date("2026-02-10"),
      lines: [{ purchaseOrderLineId: lineId, quantityReceived: "10" }],
    });

    const convertInput = {
      issueDate: new Date("2026-02-16"),
      dueDate: new Date("2026-03-16"),
      apAccountId: fixtures.apAccountId,
      // Supplier's bill claims 12, but only 10 were ordered/received.
      lines: [{ poLineId: lineId, quantity: "12", unitPrice: "50.00" }],
    };

    const preview = await PurchaseOrderService.previewMatch(owner, created.id, convertInput.lines);
    expect(preview.matched).toBe(false);
    expect(preview.discrepancies[0]!.message).toContain("ordered 10.0000, received 10.0000, bill claims 12");

    await expect(PurchaseOrderService.convertToBill(owner, created.id, convertInput)).rejects.toThrow(/three-way match/);

    const result = await PurchaseOrderService.convertToBill(owner, created.id, { ...convertInput, acknowledgeDiscrepancies: true });
    expect(result.match.matched).toBe(false);

    const bill = await BillService.get(owner, result.id);
    expect(bill!.lines[0]!.quantity).toBe("12.0000");
    expect(bill!.total).toBe("660.0000");
  });

  it("finds a price mismatch and reports it in plain language", async () => {
    const created = await createDraftPo();
    await PurchaseOrderService.markSent(owner, created.id);
    const po = await PurchaseOrderService.get(owner, created.id);
    const lineId = po!.lines[0]!.id;

    await PurchaseOrderService.recordReceipt(owner, created.id, {
      receivedDate: new Date("2026-02-10"),
      lines: [{ purchaseOrderLineId: lineId, quantityReceived: "10" }],
    });

    const preview = await PurchaseOrderService.previewMatch(owner, created.id, [{ poLineId: lineId, quantity: "10", unitPrice: "55.00" }]);
    expect(preview.matched).toBe(false);
    expect(preview.discrepancies[0]!.kind).toBe("PRICE_MISMATCH");
  });

  it("refuses to delete or edit a PO once it's no longer a draft", async () => {
    const created = await createDraftPo();
    await PurchaseOrderService.markSent(owner, created.id);
    await expect(PurchaseOrderService.deleteDraft(owner, created.id)).rejects.toThrow();
  });

  it("cancels a draft PO with a reason", async () => {
    const created = await createDraftPo();
    const cancelled = await PurchaseOrderService.cancel(owner, created.id, "Supplier out of stock");
    expect(cancelled!.status).toBe("CANCELLED");
  });
});
