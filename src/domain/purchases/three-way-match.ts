import Decimal from "decimal.js";
import { Money } from "@/domain/money/money";
import type { ThreeWayMatchDiscrepancy, ThreeWayMatchResult } from "./types";

export interface ThreeWayMatchPoLine {
  id: string;
  description: string;
  /** Decimal string — what was ordered. */
  quantity: string;
  /** Decimal string — what's been recorded as received against this line so far. */
  quantityReceived: string;
  /** Decimal string — the PO's own agreed unit price. */
  unitPrice: string;
}

export interface ThreeWayMatchBillLine {
  poLineId: string;
  /** Decimal string — what the supplier's bill claims for this line. */
  quantity: string;
  /** Decimal string — what the supplier's bill charges per unit for this line. */
  unitPrice: string;
}

/**
 * Pure, DB-free three-way-match comparison — "PO → Goods Received →
 * Supplier Invoice" per master spec §16, scoped to what a business without a
 * full inventory module can meaningfully check: quantity and price, not
 * warehouse location/lot/serial (that needs Phase 7's inventory system, see
 * docs/roadmap.md). Every discrepancy is reported with a plain-language
 * explanation; this function never decides to accept or reject anything —
 * `PurchaseOrderService.convertToBill` surfaces the result to a human, who
 * must explicitly confirm before the bill proceeds (`acknowledgeDiscrepancies`).
 */
export function threeWayMatch(
  poLines: ThreeWayMatchPoLine[],
  billLines: ThreeWayMatchBillLine[],
  currency: string,
): ThreeWayMatchResult {
  const poLinesById = new Map(poLines.map((l) => [l.id, l]));
  const discrepancies: ThreeWayMatchDiscrepancy[] = [];

  for (const billLine of billLines) {
    const poLine = poLinesById.get(billLine.poLineId);
    if (!poLine) continue; // Unknown PO line ids are a validation error elsewhere, not a match discrepancy.

    const ordered = new Decimal(poLine.quantity);
    const received = new Decimal(poLine.quantityReceived);
    const billed = new Decimal(billLine.quantity);
    const orderedPrice = Money.of(poLine.unitPrice, currency);
    const billedPrice = Money.of(billLine.unitPrice, currency);

    if (billed.greaterThan(received)) {
      discrepancies.push({
        poLineId: poLine.id,
        description: poLine.description,
        orderedQuantity: poLine.quantity,
        receivedQuantity: poLine.quantityReceived,
        billedQuantity: billLine.quantity,
        orderedUnitPrice: poLine.unitPrice,
        billedUnitPrice: billLine.unitPrice,
        kind: billed.greaterThan(ordered) ? "QUANTITY_EXCEEDS_ORDERED" : "QUANTITY_EXCEEDS_RECEIVED",
        message: billed.greaterThan(ordered)
          ? `"${poLine.description}": ordered ${poLine.quantity}, received ${poLine.quantityReceived}, bill claims ${billLine.quantity} — exceeds even the quantity ordered.`
          : `"${poLine.description}": ordered ${poLine.quantity}, received ${poLine.quantityReceived}, bill claims ${billLine.quantity} — quantity mismatch (billed more than received).`,
      });
    }

    if (!orderedPrice.equals(billedPrice)) {
      discrepancies.push({
        poLineId: poLine.id,
        description: poLine.description,
        orderedQuantity: poLine.quantity,
        receivedQuantity: poLine.quantityReceived,
        billedQuantity: billLine.quantity,
        orderedUnitPrice: poLine.unitPrice,
        billedUnitPrice: billLine.unitPrice,
        kind: "PRICE_MISMATCH",
        message: `"${poLine.description}": ordered @ ${orderedPrice.toString()}, bill claims @ ${billedPrice.toString()} — price mismatch.`,
      });
    }
  }

  return { matched: discrepancies.length === 0, discrepancies };
}
