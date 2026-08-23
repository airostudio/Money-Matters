"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface AccountOption {
  id: string;
  code: string;
  name: string;
}

interface Row {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

let nextKey = 0;
const emptyRow = (): Row => ({ key: nextKey++, accountId: "", debit: "", credit: "", memo: "" });

/**
 * Client-side line editor for a journal entry. The running total shown here
 * is an indicative preview only (plain float arithmetic on whatever the
 * user has typed so far) — the actual balance check is re-done server-side
 * in PostingService against Decimal amounts before anything is persisted.
 * See docs/accounting-engine.md §4.
 */
export function JournalLineEditor({ accounts, currency }: { accounts: AccountOption[]; currency: string }) {
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);

  const { totalDebit, totalCredit } = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const row of rows) {
      debit += Number(row.debit) || 0;
      credit += Number(row.credit) || 0;
    }
    return { totalDebit: debit, totalCredit: credit };
  }, [rows]);

  const balanced = rows.some((r) => r.debit || r.credit) && Math.abs(totalDebit - totalCredit) < 0.005;

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(key: number) {
    setRows((prev) => (prev.length > 2 ? prev.filter((r) => r.key !== key) : prev));
  }

  return (
    <div className="space-y-3">
      <div className="hidden grid-cols-[1fr_140px_140px_1fr_36px] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid">
        <span>Account</span>
        <span>Debit</span>
        <span>Credit</span>
        <span>Memo</span>
        <span />
      </div>
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_140px_140px_1fr_36px]">
          <select
            name="lineAccountId"
            required
            value={row.accountId}
            onChange={(e) => updateRow(row.key, { accountId: e.target.value })}
            className="col-span-2 h-9 rounded-md border border-input bg-background px-3 text-sm sm:col-span-1"
          >
            <option value="" disabled>
              Select account…
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
          <Input
            name="lineDebit"
            inputMode="decimal"
            placeholder="0.00"
            value={row.debit}
            onChange={(e) => updateRow(row.key, { debit: e.target.value, credit: e.target.value ? "" : row.credit })}
          />
          <Input
            name="lineCredit"
            inputMode="decimal"
            placeholder="0.00"
            value={row.credit}
            onChange={(e) => updateRow(row.key, { credit: e.target.value, debit: e.target.value ? "" : row.debit })}
          />
          <Input
            name="lineMemo"
            placeholder="Memo (optional)"
            value={row.memo}
            onChange={(e) => updateRow(row.key, { memo: e.target.value })}
            className="col-span-2 sm:col-span-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => removeRow(row.key)}
            disabled={rows.length <= 2}
            aria-label="Remove line"
          >
            <Trash2 className="size-4" />
          </Button>
          <input type="hidden" name="lineCurrency" value={currency} />
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        <Plus /> Add line
      </Button>

      <div className="flex items-center justify-end gap-6 border-t border-border pt-3 text-sm">
        <span className="text-muted-foreground">
          Debit <span className="font-medium text-foreground">{totalDebit.toFixed(2)}</span>
        </span>
        <span className="text-muted-foreground">
          Credit <span className="font-medium text-foreground">{totalCredit.toFixed(2)}</span>
        </span>
        <span className={balanced ? "font-medium text-success" : "font-medium text-muted-foreground"}>
          {balanced ? "Balanced" : "Not balanced yet"}
        </span>
      </div>
    </div>
  );
}
