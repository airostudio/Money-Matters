"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface RevenueAccountOption {
  id: string;
  code: string;
  name: string;
}

export interface TaxCodeOption {
  id: string;
  code: string;
  name: string;
  rate: string;
}

/** Phase 7 Slice 2 (Inventory): a catalog product selectable on a line. Omit the `products` prop entirely for a line type that doesn't support one yet (quotes, POs, recurring templates — see docs/roadmap.md). */
export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  sellPrice: string | null;
}

interface Row {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string;
  productId: string;
}

let nextKey = 0;
const emptyRow = (): Row => ({
  key: nextKey++,
  description: "",
  quantity: "1",
  unitPrice: "",
  accountId: "",
  taxCodeId: "",
  productId: "",
});

/**
 * Client-side line editor for a draft invoice/bill. The subtotal/tax/total
 * shown here is an indicative preview only (plain float arithmetic on
 * whatever has been typed so far) — the real computation happens
 * server-side in `calculateInvoiceTotals`/`calculateBillTotals` against
 * Decimal amounts before anything is persisted. See
 * docs/accounting-engine.md §4.
 *
 * When `products` is supplied and a row picks one (Phase 7 Slice 2), the
 * account column is cleared and no longer required for that row — the
 * server resolves/overwrites the posting account from the product's own
 * wiring instead of whatever's picked here, see
 * `InvoiceService`/`BillService`'s `resolveProductLines`.
 */
export function InvoiceLineEditor({
  accounts,
  taxCodes,
  products,
  initialLines,
}: {
  accounts: RevenueAccountOption[];
  taxCodes: TaxCodeOption[];
  products?: ProductOption[];
  initialLines?: Array<{ description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId: string | null }>;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    initialLines && initialLines.length > 0
      ? initialLines.map((l) => ({ key: nextKey++, ...l, taxCodeId: l.taxCodeId ?? "", productId: "" }))
      : [emptyRow()],
  );
  const productsById = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);

  const rateByCode = useMemo(() => new Map(taxCodes.map((t) => [t.id, Number(t.rate)])), [taxCodes]);

  const { subtotal, taxTotal } = useMemo(() => {
    let sub = 0;
    let tax = 0;
    for (const row of rows) {
      const lineAmount = (Number(row.quantity) || 0) * (Number(row.unitPrice) || 0);
      sub += lineAmount;
      if (row.taxCodeId) tax += lineAmount * (rateByCode.get(row.taxCodeId) ?? 0);
    }
    return { subtotal: sub, taxTotal: tax };
  }, [rows, rateByCode]);

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(key: number) {
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }

  const hasProducts = (products?.length ?? 0) > 0;
  const gridCols = hasProducts
    ? "sm:grid-cols-[1.6fr_1fr_90px_110px_1fr_140px_36px]"
    : "sm:grid-cols-[2fr_90px_110px_1fr_140px_36px]";

  return (
    <div className="space-y-3">
      <div className={`hidden grid-cols-2 gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid ${gridCols}`}>
        <span>Description</span>
        {hasProducts && <span>Product</span>}
        <span>Qty</span>
        <span>Unit price</span>
        <span>{hasProducts ? "Account (if no product)" : "Account"}</span>
        <span>Tax</span>
        <span />
      </div>
      {rows.map((row) => (
        <div key={row.key} className={`grid grid-cols-2 gap-2 ${gridCols}`}>
          <Input
            name="lineDescription"
            placeholder="Description"
            value={row.description}
            onChange={(e) => updateRow(row.key, { description: e.target.value })}
            required
            className="col-span-2 sm:col-span-1"
          />
          {hasProducts && (
            <select
              name="lineProductId"
              value={row.productId}
              onChange={(e) => {
                const productId = e.target.value;
                const product = productsById.get(productId);
                updateRow(row.key, {
                  productId,
                  accountId: productId ? "" : row.accountId,
                  description: product && !row.description ? product.name : row.description,
                  unitPrice: product?.sellPrice && !row.unitPrice ? product.sellPrice : row.unitPrice,
                });
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">No product (ad hoc line)</option>
              {(products ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} · {p.name}
                </option>
              ))}
            </select>
          )}
          <Input
            name="lineQuantity"
            inputMode="decimal"
            placeholder="1"
            value={row.quantity}
            onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
            required
          />
          <Input
            name="lineUnitPrice"
            inputMode="decimal"
            placeholder="0.00"
            value={row.unitPrice}
            onChange={(e) => updateRow(row.key, { unitPrice: e.target.value })}
            required
          />
          <select
            name="lineAccountId"
            required={!row.productId}
            disabled={!!row.productId}
            value={row.accountId}
            onChange={(e) => updateRow(row.key, { accountId: e.target.value })}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
          >
            <option value="" disabled>
              {row.productId ? "Resolved from product" : "Select account…"}
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
          <select
            name="lineTaxCodeId"
            value={row.taxCodeId}
            onChange={(e) => updateRow(row.key, { taxCodeId: e.target.value })}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">No tax</option>
            {taxCodes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} ({(Number(t.rate) * 100).toFixed(0)}%)
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => removeRow(row.key)}
            disabled={rows.length <= 1}
            aria-label="Remove line"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus /> Add line
      </Button>

      <div className="flex items-center justify-end gap-6 border-t border-border pt-3 text-sm">
        <span className="text-muted-foreground">
          Subtotal <span className="font-medium text-foreground">{subtotal.toFixed(2)}</span>
        </span>
        <span className="text-muted-foreground">
          Tax <span className="font-medium text-foreground">{taxTotal.toFixed(2)}</span>
        </span>
        <span className="font-medium">Total {(subtotal + taxTotal).toFixed(2)}</span>
      </div>
    </div>
  );
}
