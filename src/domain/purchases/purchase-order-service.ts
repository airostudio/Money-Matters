import { and, asc, desc, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accounts,
  contacts,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrderReceipts,
  purchaseOrders,
  taxCodes,
  type purchaseOrderStatusEnum,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import {
  InvalidBillLineError,
  InvalidContactForBillError,
  InvalidPurchaseOrderLineError,
  PurchaseOrderAlreadyConvertedError,
  PurchaseOrderNotConvertibleError,
  PurchaseOrderNotEditableError,
  PurchaseOrderNotFoundError,
  PurchaseOrderNotReceivableError,
  ReceiptExceedsOrderedQuantityError,
  UnacknowledgedMatchDiscrepancyError,
} from "./errors";
import { calculateBillTotals } from "./bill-calculations";
import { nextPurchaseOrderNumber } from "./numbering";
import { threeWayMatch } from "./three-way-match";
import { BillService } from "./bill-service";
import type {
  ConvertPurchaseOrderToBillInput,
  CreatePurchaseOrderInput,
  RecordPurchaseOrderReceiptInput,
  ThreeWayMatchResult,
  UpdatePurchaseOrderInput,
} from "./types";

type PoStatus = (typeof purchaseOrderStatusEnum.enumValues)[number];

const EDITABLE_STATUSES: PoStatus[] = ["DRAFT"];
/** A PO can still receive goods against it in any of these states. */
const RECEIVABLE_STATUSES: PoStatus[] = ["SENT", "PARTIALLY_RECEIVED"];

async function assertActiveSupplier(tx: TenantDb, organizationId: string, contactId: string) {
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)));
  if (!contact || !contact.isActive || (contact.kind !== "SUPPLIER" && contact.kind !== "BOTH")) {
    throw new InvalidContactForBillError(contactId);
  }
  return contact;
}

async function assertAccountsUsable(tx: TenantDb, organizationId: string, accountIds: string[]) {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return;
  const rows = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, uniqueIds)));
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of uniqueIds) {
    const row = found.get(id);
    if (!row) throw new InvalidPurchaseOrderLineError(`Account ${id} does not exist in this organization.`);
    if (!row.isActive) throw new InvalidPurchaseOrderLineError(`Account ${id} is inactive.`);
  }
}

async function loadTaxRates(tx: TenantDb, organizationId: string, taxCodeIds: string[]) {
  const uniqueIds = [...new Set(taxCodeIds)];
  if (uniqueIds.length === 0) return new Map<string, string>();
  const rows = await tx
    .select({ id: taxCodes.id, rate: taxCodes.rate })
    .from(taxCodes)
    .where(and(eq(taxCodes.organizationId, organizationId), inArray(taxCodes.id, uniqueIds)));
  return new Map(rows.map((r) => [r.id, r.rate]));
}

async function loadPoOr404(tx: TenantDb, organizationId: string, poId: string) {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.organizationId, organizationId)));
  if (!po) throw new PurchaseOrderNotFoundError(poId);
  return po;
}

async function loadPoLines(tx: TenantDb, poId: string) {
  return tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId)).orderBy(asc(purchaseOrderLines.lineNumber));
}

/** Recomputes and persists a PO's PARTIALLY_RECEIVED/RECEIVED status from its lines' actual quantityReceived — never trusted from the caller. */
async function refreshPoStatus(tx: TenantDb, actor: Actor, poId: string): Promise<void> {
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (!po || !RECEIVABLE_STATUSES.includes(po.status)) return;

  const lines = await loadPoLines(tx, poId);
  const allFull = lines.every((l) => new Decimal(l.quantityReceived).greaterThanOrEqualTo(l.quantity));
  const anyReceived = lines.some((l) => new Decimal(l.quantityReceived).greaterThan(0));

  const nextStatus: PoStatus = allFull ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;
  if (nextStatus === po.status) return;

  await tx.update(purchaseOrders).set({ status: nextStatus, updatedById: actor.userId, updatedAt: new Date() }).where(eq(purchaseOrders.id, poId));

  await AuditService.record(tx, actor, {
    action: "purchase_order.receiving_status_updated",
    entityType: "PurchaseOrder",
    entityId: poId,
    before: { status: po.status },
    after: { status: nextStatus },
  });
}

async function persistPoWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreatePurchaseOrderInput,
  existingId?: string,
): Promise<{ id: string; poNumber: string }> {
  const supplier = await assertActiveSupplier(tx, actor.organizationId, input.supplierContactId);
  await assertAccountsUsable(tx, actor.organizationId, input.lines.map((l) => l.accountId));

  const taxCodeIds = input.lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const rateByCode = await loadTaxRates(tx, actor.organizationId, taxCodeIds);

  // `calculateBillTotals` is reused verbatim — a PO's line/tax/total math is
  // identical to a bill's (docs/accounting-engine.md §4), even though a PO
  // never itself posts anything.
  const totals = calculateBillTotals(input.lines, input.currency, rateByCode);

  let poId: string;
  let poNumber: string;

  if (existingId) {
    const [updated] = await tx
      .update(purchaseOrders)
      .set({
        supplierContactId: input.supplierContactId,
        issueDate: input.issueDate,
        expectedDate: input.expectedDate ?? null,
        currency: input.currency,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, existingId))
      .returning({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber });
    if (!updated) throw new Error("Failed to update purchase order.");
    poId = updated.id;
    poNumber = updated.poNumber;
    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, existingId));
  } else {
    poNumber = await nextPurchaseOrderNumber(tx, actor.organizationId);
    const [created] = await tx
      .insert(purchaseOrders)
      .values({
        organizationId: actor.organizationId,
        supplierContactId: input.supplierContactId,
        poNumber,
        issueDate: input.issueDate,
        expectedDate: input.expectedDate ?? null,
        currency: input.currency,
        memo: input.memo ?? null,
        status: "DRAFT",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdById: actor.userId,
        updatedById: actor.userId,
      })
      .returning({ id: purchaseOrders.id });
    if (!created) throw new Error("Failed to create purchase order.");
    poId = created.id;
  }

  await tx.insert(purchaseOrderLines).values(
    totals.lines.map((line, i) => ({
      organizationId: actor.organizationId,
      purchaseOrderId: poId,
      lineNumber: i + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxCodeId: line.taxCodeId,
      lineAmount: line.lineAmount,
      taxAmount: line.taxAmount,
      quantityReceived: "0",
    })),
  );

  await AuditService.record(tx, actor, {
    action: existingId ? "purchase_order.updated" : "purchase_order.draft_created",
    entityType: "PurchaseOrder",
    entityId: poId,
    after: { poNumber, supplier: supplier.displayName, ...totals },
  });

  return { id: poId, poNumber };
}

export const PurchaseOrderService = {
  async list(actor: Actor, opts: { status?: PoStatus; supplierContactId?: string } = {}) {
    assertPermission(actor, "purchase_order:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(purchaseOrders.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(purchaseOrders.status, opts.status));
      if (opts.supplierContactId) conditions.push(eq(purchaseOrders.supplierContactId, opts.supplierContactId));

      const rows = await tx
        .select({ po: purchaseOrders, supplier: contacts })
        .from(purchaseOrders)
        .innerJoin(contacts, eq(contacts.id, purchaseOrders.supplierContactId))
        .where(and(...conditions))
        .orderBy(desc(purchaseOrders.issueDate), desc(purchaseOrders.poNumber));

      return rows.map((row) => ({ ...row.po, supplier: row.supplier }));
    });
  },

  async get(actor: Actor, poId: string) {
    assertPermission(actor, "purchase_order:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ po: purchaseOrders, supplier: contacts })
        .from(purchaseOrders)
        .innerJoin(contacts, eq(contacts.id, purchaseOrders.supplierContactId))
        .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: purchaseOrderLines, account: accounts, taxCode: taxCodes })
        .from(purchaseOrderLines)
        .innerJoin(accounts, eq(accounts.id, purchaseOrderLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, purchaseOrderLines.taxCodeId))
        .where(eq(purchaseOrderLines.purchaseOrderId, poId))
        .orderBy(asc(purchaseOrderLines.lineNumber));

      const receipts = await tx
        .select()
        .from(purchaseOrderReceipts)
        .where(eq(purchaseOrderReceipts.purchaseOrderId, poId))
        .orderBy(desc(purchaseOrderReceipts.receivedDate));

      return {
        ...row.po,
        supplier: row.supplier,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
        receipts,
      };
    });
  },

  async create(actor: Actor, input: CreatePurchaseOrderInput) {
    assertPermission(actor, "purchase_order:manage");
    return withTenant(actor.organizationId, (tx) => persistPoWithLines(tx, actor, input));
  },

  async update(actor: Actor, poId: string, input: UpdatePurchaseOrderInput) {
    assertPermission(actor, "purchase_order:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadPoOr404(tx, actor.organizationId, poId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new PurchaseOrderNotEditableError(existing.poNumber);
      }
      return persistPoWithLines(tx, actor, input, poId);
    });
  },

  async deleteDraft(actor: Actor, poId: string) {
    assertPermission(actor, "purchase_order:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadPoOr404(tx, actor.organizationId, poId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new PurchaseOrderNotEditableError(existing.poNumber);
      }
      await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, poId));
      await AuditService.record(tx, actor, {
        action: "purchase_order.draft_deleted",
        entityType: "PurchaseOrder",
        entityId: poId,
        before: { poNumber: existing.poNumber },
      });
    });
  },

  /** DRAFT -> SENT. Idempotent if already SENT. A PO never posts to the ledger — this is purely a workflow marker. */
  async markSent(actor: Actor, poId: string) {
    assertPermission(actor, "purchase_order:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const po = await loadPoOr404(tx, actor.organizationId, poId);
      if (po.status === "SENT" || po.status === "PARTIALLY_RECEIVED" || po.status === "RECEIVED") return po;
      if (po.status !== "DRAFT") throw new PurchaseOrderNotEditableError(po.poNumber);

      const [updated] = await tx
        .update(purchaseOrders)
        .set({ status: "SENT", sentAt: new Date(), updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(purchaseOrders.id, poId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "purchase_order.sent",
        entityType: "PurchaseOrder",
        entityId: poId,
        before: { status: po.status },
        after: { status: "SENT" },
      });

      return updated;
    });
  },

  async cancel(actor: Actor, poId: string, reason: string) {
    assertPermission(actor, "purchase_order:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const po = await loadPoOr404(tx, actor.organizationId, poId);
      if (po.status === "RECEIVED") throw new PurchaseOrderNotEditableError(po.poNumber);

      const [updated] = await tx
        .update(purchaseOrders)
        .set({
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledById: actor.userId,
          cancelReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, poId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "purchase_order.cancelled",
        entityType: "PurchaseOrder",
        entityId: poId,
        before: { status: po.status },
        after: { status: "CANCELLED", reason },
      });

      return updated;
    });
  },

  /** Manually closes a PO that won't receive any more goods (e.g. the supplier under-shipped the remainder). */
  async close(actor: Actor, poId: string) {
    assertPermission(actor, "purchase_order:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const po = await loadPoOr404(tx, actor.organizationId, poId);
      if (!RECEIVABLE_STATUSES.includes(po.status)) throw new PurchaseOrderNotReceivableError(po.poNumber);

      const [updated] = await tx
        .update(purchaseOrders)
        .set({ status: "CLOSED", closedAt: new Date(), closedById: actor.userId, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(purchaseOrders.id, poId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "purchase_order.closed",
        entityType: "PurchaseOrder",
        entityId: poId,
        before: { status: po.status },
        after: { status: "CLOSED" },
      });

      return updated;
    });
  },

  /**
   * Records goods received against one or more of a PO's lines. Deliberately
   * lightweight — no warehouse location, no serial/lot tracking, and no
   * ledger posting (there is no inventory asset account to debit without a
   * real inventory module, see docs/roadmap.md). Advances each line's
   * `quantityReceived` and recomputes the PO's own
   * PARTIALLY_RECEIVED/RECEIVED status, never trusting a stored belief.
   */
  async recordReceipt(actor: Actor, poId: string, input: RecordPurchaseOrderReceiptInput) {
    assertPermission(actor, "purchase_order:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const po = await loadPoOr404(tx, actor.organizationId, poId);
      if (!RECEIVABLE_STATUSES.includes(po.status)) {
        throw new PurchaseOrderNotReceivableError(po.poNumber);
      }
      if (input.lines.length === 0) {
        throw new InvalidPurchaseOrderLineError("A receipt needs at least one line.");
      }

      const poLines = await loadPoLines(tx, poId);
      const poLinesById = new Map(poLines.map((l) => [l.id, l]));

      const [receipt] = await tx
        .insert(purchaseOrderReceipts)
        .values({
          organizationId: actor.organizationId,
          purchaseOrderId: poId,
          receivedDate: input.receivedDate,
          memo: input.memo ?? null,
          createdById: actor.userId,
        })
        .returning();
      if (!receipt) throw new Error("Failed to record receipt.");

      for (const line of input.lines) {
        const poLine = poLinesById.get(line.purchaseOrderLineId);
        if (!poLine) throw new InvalidPurchaseOrderLineError(`PO line ${line.purchaseOrderLineId} does not belong to this purchase order.`);

        const qty = new Decimal(line.quantityReceived);
        if (!qty.greaterThan(0)) {
          throw new InvalidPurchaseOrderLineError(`Received quantity for "${poLine.description}" must be greater than zero.`);
        }

        const ordered = new Decimal(poLine.quantity);
        const alreadyReceived = new Decimal(poLine.quantityReceived);
        const newTotal = alreadyReceived.plus(qty);
        if (newTotal.greaterThan(ordered)) {
          throw new ReceiptExceedsOrderedQuantityError(poLine.description, poLine.quantity, poLine.quantityReceived, line.quantityReceived);
        }

        await tx.insert(purchaseOrderReceiptLines).values({
          organizationId: actor.organizationId,
          receiptId: receipt.id,
          purchaseOrderLineId: poLine.id,
          quantityReceived: line.quantityReceived,
        });

        await tx
          .update(purchaseOrderLines)
          .set({ quantityReceived: newTotal.toFixed(4) })
          .where(eq(purchaseOrderLines.id, poLine.id));

        // Keep the in-memory map current for the status recompute below.
        poLine.quantityReceived = newTotal.toFixed(4);
      }

      await refreshPoStatus(tx, actor, poId);

      await AuditService.record(tx, actor, {
        action: "purchase_order.received",
        entityType: "PurchaseOrder",
        entityId: poId,
        after: { receiptId: receipt.id, lines: input.lines },
      });

      return receipt;
    });
  },

  /**
   * Compares what's been received against a PO's lines with what the
   * supplier's bill claims — quantity and price only (see
   * `src/domain/purchases/three-way-match.ts`) — without creating anything.
   * The bill/PO conversion UI calls this first to show the human any
   * discrepancy before they confirm.
   */
  async previewMatch(actor: Actor, poId: string, billLines: ConvertPurchaseOrderToBillInput["lines"]): Promise<ThreeWayMatchResult> {
    assertPermission(actor, "purchase_order:read");
    return withTenant(actor.organizationId, async (tx) => {
      const po = await loadPoOr404(tx, actor.organizationId, poId);
      const poLines = await loadPoLines(tx, poId);
      return threeWayMatch(
        poLines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity, quantityReceived: l.quantityReceived, unitPrice: l.unitPrice })),
        billLines.map((l) => ({ poLineId: l.poLineId, quantity: l.quantity, unitPrice: l.unitPrice })),
        po.currency,
      );
    });
  },

  /**
   * Turns a received (or partially-received) PO into a normal draft bill via
   * `BillService.create` — never a shortcut around it: same validation, same
   * `calculateBillTotals` call, same audit trail. Runs the three-way match
   * first; if it finds any discrepancy, this refuses unless
   * `acknowledgeDiscrepancies` is explicitly true — the "confirm anyway"
   * step a human takes after seeing the plain-language warning, never a
   * silent auto-accept or auto-reject. The resulting bill is always a DRAFT
   * requiring the normal `BillService.approveAndPost` step — a PO conversion
   * never auto-posts.
   */
  async convertToBill(actor: Actor, poId: string, input: ConvertPurchaseOrderToBillInput) {
    assertPermission(actor, "purchase_order:manage");
    assertPermission(actor, "supplier_bill:manage");

    const po = await withTenant(actor.organizationId, (tx) => loadPoOr404(tx, actor.organizationId, poId));
    if (po.status === "CLOSED") throw new PurchaseOrderAlreadyConvertedError(po.poNumber);
    if (po.status !== "PARTIALLY_RECEIVED" && po.status !== "RECEIVED") {
      throw new PurchaseOrderNotConvertibleError(po.poNumber);
    }
    if (input.lines.length === 0) {
      throw new InvalidBillLineError("A bill needs at least one line.");
    }

    const full = await PurchaseOrderService.get(actor, poId);
    if (!full) throw new PurchaseOrderNotFoundError(poId);

    const match = threeWayMatch(
      full.lines.map((l) => ({ id: l.id, description: l.description, quantity: l.quantity, quantityReceived: l.quantityReceived, unitPrice: l.unitPrice })),
      input.lines.map((l) => ({ poLineId: l.poLineId, quantity: l.quantity, unitPrice: l.unitPrice })),
      po.currency,
    );

    if (!match.matched && !input.acknowledgeDiscrepancies) {
      throw new UnacknowledgedMatchDiscrepancyError();
    }

    const poLinesById = new Map(full.lines.map((l) => [l.id, l]));
    const bill = await BillService.create(actor, {
      supplierContactId: full.supplierContactId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency: po.currency,
      apAccountId: input.apAccountId,
      memo: input.memo ?? `Converted from purchase order ${full.poNumber}`,
      supplierReference: input.supplierReference,
      purchaseOrderId: po.id,
      lines: input.lines.map((l) => {
        const poLine = poLinesById.get(l.poLineId);
        if (!poLine) throw new InvalidBillLineError(`PO line ${l.poLineId} does not belong to purchase order ${full.poNumber}.`);
        return {
          description: poLine.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          accountId: poLine.accountId,
          taxCodeId: poLine.taxCodeId ?? undefined,
        };
      }),
    });

    await withTenant(actor.organizationId, async (tx) => {
      await AuditService.record(tx, actor, {
        action: "purchase_order.converted_to_bill",
        entityType: "PurchaseOrder",
        entityId: poId,
        after: {
          billId: bill.id,
          billNumber: bill.billNumber,
          matched: match.matched,
          discrepancies: match.discrepancies,
          acknowledged: input.acknowledgeDiscrepancies ?? false,
        },
      });
    });

    return { ...bill, match };
  },
};
