import Link from "next/link";
import { Money } from "@/domain/money/money";
import { entityAccountHref } from "@/domain/consolidation/drill-down";
import type {
  AppliedAdjustment,
  ColumnTotals,
  ConsolidatedLine,
  ConsolidatedSection,
  EliminationEntry,
  EntityColumn,
  ExclusionNotice,
  IntercompanyReconciliationRow,
} from "@/domain/consolidation/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

const MAPPING_LABEL: Record<string, string> = {
  EXPLICIT: "mapped by you",
  DEFAULT: "same code + type",
  UNMAPPED: "unmapped",
  COMPUTED: "computed",
};

function elimAndAdj(a: { eliminations: string; adjustments: string }): string {
  return Money.of(a.eliminations, "X").add(Money.of(a.adjustments, "X")).toString();
}

export function ExclusionBanner({ exclusions, deselectedCount }: { exclusions: ExclusionNotice; deselectedCount: number }) {
  if (!exclusions.notice && deselectedCount === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      {exclusions.notice && (
        <p>
          <strong>{exclusions.notice}.</strong> This report covers only the entities your own role lets you read.
          {exclusions.knownNames.length > 0 && <> Your role cannot read reports in: {exclusions.knownNames.join(", ")}.</>}
        </p>
      )}
      {deselectedCount > 0 && (
        <p>
          {deselectedCount} {deselectedCount === 1 ? "entity is" : "entities are"} switched off in this group&apos;s settings.
        </p>
      )}
    </div>
  );
}

function LineRow({
  line,
  entities,
  currency,
  range,
}: {
  line: ConsolidatedLine;
  entities: EntityColumn[];
  currency: string;
  range: { from?: string; to: string };
}) {
  return (
    <tr className={line.kind === "UNMAPPED" ? "bg-amber-500/5" : undefined}>
      <td className="px-4 py-2 align-top">
        <details>
          <summary className="cursor-pointer list-none">
            {line.code && <span className="font-mono text-xs text-muted-foreground">{line.code}</span>}{" "}
            <span className={line.kind === "COMPUTED" ? "italic text-muted-foreground" : undefined}>{line.name}</span>
          </summary>
          <ul className="mt-2 space-y-1 border-l border-border pl-3 text-xs">
            {line.sources.map((s, i) => {
              const href = entityAccountHref(s, range);
              const entityName = entities.find((e) => e.organizationId === s.organizationId)?.name ?? "";
              return (
                <li key={`${s.organizationId}-${s.accountId ?? i}-${i}`} className="text-muted-foreground">
                  {entityName}:{" "}
                  {href ? (
                    <Link href={href} className="text-primary hover:underline">
                      {s.code} {s.name}
                    </Link>
                  ) : (
                    <span>{s.name}</span>
                  )}{" "}
                  <MoneyDisplay amount={s.amount} currency={currency} /> <span className="opacity-70">({MAPPING_LABEL[s.mapping]})</span>
                </li>
              );
            })}
            {line.sources.length === 0 && <li className="text-muted-foreground">Only eliminations / adjustments affect this line.</li>}
          </ul>
        </details>
      </td>
      {entities.map((e) => (
        <td key={e.organizationId} className="px-4 py-2 text-right align-top">
          <MoneyDisplay amount={line.byEntity[e.organizationId] ?? "0"} currency={currency} />
        </td>
      ))}
      <td className="px-4 py-2 text-right align-top">
        <MoneyDisplay amount={line.combined} currency={currency} />
      </td>
      <td className="px-4 py-2 text-right align-top">
        <MoneyDisplay amount={elimAndAdj(line)} currency={currency} />
      </td>
      <td className="px-4 py-2 text-right align-top font-medium">
        <MoneyDisplay amount={line.consolidated} currency={currency} />
      </td>
    </tr>
  );
}

function TotalRow({ label, totals, entities, currency, strong }: { label: string; totals: ColumnTotals; entities: EntityColumn[]; currency: string; strong?: boolean }) {
  return (
    <tr className={strong ? "border-t-2 border-border font-semibold" : "font-medium"}>
      <td className="px-4 py-2">{label}</td>
      {entities.map((e) => (
        <td key={e.organizationId} className="px-4 py-2 text-right">
          <MoneyDisplay amount={totals.byEntity[e.organizationId] ?? "0"} currency={currency} />
        </td>
      ))}
      <td className="px-4 py-2 text-right">
        <MoneyDisplay amount={totals.combined} currency={currency} />
      </td>
      <td className="px-4 py-2 text-right">
        <MoneyDisplay amount={elimAndAdj(totals)} currency={currency} />
      </td>
      <td className="px-4 py-2 text-right">
        <MoneyDisplay amount={totals.consolidated} currency={currency} />
      </td>
    </tr>
  );
}

export interface StatementSection {
  title: string;
  section: ConsolidatedSection;
  totalLabel: string;
}

/**
 * The consolidated statement table: one column per entity, the combined column,
 * the "eliminations & adjustments" column, and the consolidated total. Each line
 * expands to the entity accounts it was built from, each linking to that
 * ENTITY's own transactions page (which re-checks the user's permission there).
 */
export function ConsolidatedTable({
  entities,
  sections,
  extraTotals,
  currency,
  range,
}: {
  entities: EntityColumn[];
  sections: StatementSection[];
  extraTotals?: Array<{ label: string; totals: ColumnTotals; strong?: boolean }>;
  currency: string;
  range: { from?: string; to: string };
}) {
  return (
    <Card>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-border text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Line</th>
              {entities.map((e) => (
                <th key={e.organizationId} className="px-4 py-2 text-right font-medium">
                  {e.name}
                  <div className="text-[10px] font-normal uppercase">{e.role === "PARENT" ? "parent" : "subsidiary"}</div>
                </th>
              ))}
              <th className="px-4 py-2 text-right font-medium">Combined</th>
              <th className="px-4 py-2 text-right font-medium">Elim. &amp; adj.</th>
              <th className="px-4 py-2 text-right font-medium">Consolidated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sections.map((s) => (
              <SectionBody key={s.title} s={s} entities={entities} currency={currency} range={range} />
            ))}
            {extraTotals?.map((t) => <TotalRow key={t.label} label={t.label} totals={t.totals} entities={entities} currency={currency} strong={t.strong} />)}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function SectionBody({ s, entities, currency, range }: { s: StatementSection; entities: EntityColumn[]; currency: string; range: { from?: string; to: string } }) {
  return (
    <>
      <tr className="bg-muted/40">
        <td colSpan={entities.length + 4} className="px-4 py-1.5 text-xs font-semibold uppercase text-muted-foreground">
          {s.title}
        </td>
      </tr>
      {s.section.lines.map((line) => (
        <LineRow key={line.key} line={line} entities={entities} currency={currency} range={range} />
      ))}
      <TotalRow label={s.totalLabel} totals={s.section.totals} entities={entities} currency={currency} />
    </>
  );
}

export function UnmappedNotice({ count, groupId }: { count: number; groupId: string }) {
  if (count === 0) return null;
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      {count} {count === 1 ? "line sits" : "lines sit"} in an <strong>Unmapped</strong> bucket: accounts with no matching group account. They are
      included in the totals, not dropped.{" "}
      <Link href={`/app/groups/${groupId}/setup`} className="text-primary underline">
        Map them
      </Link>
      .
    </p>
  );
}

export function EliminationDetails({
  entries,
  adjustments,
  reconciliation,
  currency,
  groupId,
}: {
  entries: EliminationEntry[];
  adjustments: AppliedAdjustment[];
  reconciliation: IntercompanyReconciliationRow[];
  currency: string;
  groupId: string;
}) {
  const exceptions = reconciliation.filter((r) => r.status !== "MATCHED");
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Intercompany reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {reconciliation.length === 0 ? (
            <p className="px-6 pb-4 text-sm text-muted-foreground">
              No intercompany balances to reconcile. Designate intercompany accounts under{" "}
              <Link href={`/app/groups/${groupId}/setup`} className="text-primary underline">
                mapping &amp; intercompany
              </Link>
              .
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Type</th>
                  <th className="px-6 py-2 text-right font-medium">Creditor&apos;s books</th>
                  <th className="px-6 py-2 text-right font-medium">Debtor&apos;s books</th>
                  <th className="px-6 py-2 text-right font-medium">Eliminated</th>
                  <th className="px-6 py-2 text-right font-medium">Difference</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {reconciliation.map((r, i) => (
                  <tr key={i} className={r.status === "MATCHED" ? undefined : "bg-destructive/5"}>
                    <td className="px-6 py-2">{r.category === "TRADE" ? "Receivable / payable" : r.category === "LOAN" ? "Loan" : "Revenue / expense"}</td>
                    <td className="px-6 py-2 text-right">
                      {r.creditor ? (
                        <>
                          <div className="text-xs text-muted-foreground">{r.creditor.name}</div>
                          <MoneyDisplay amount={r.creditor.amount} currency={currency} />
                        </>
                      ) : (
                        <span className="text-xs italic text-muted-foreground">entity unavailable</span>
                      )}
                    </td>
                    <td className="px-6 py-2 text-right">
                      {r.debtor ? (
                        <>
                          <div className="text-xs text-muted-foreground">{r.debtor.name}</div>
                          <MoneyDisplay amount={r.debtor.amount} currency={currency} />
                        </>
                      ) : (
                        <span className="text-xs italic text-muted-foreground">entity unavailable</span>
                      )}
                    </td>
                    <td className="px-6 py-2 text-right">
                      <MoneyDisplay amount={r.matched} currency={currency} />
                    </td>
                    <td className="px-6 py-2 text-right">
                      <MoneyDisplay amount={r.difference} currency={currency} />
                    </td>
                    <td className="px-6 py-2 text-xs">
                      {r.status === "MATCHED" ? "Matched" : r.status === "MISMATCH" ? "Mismatch" : r.status === "ONE_SIDED" ? "One-sided" : "Counterparty unavailable"}
                      {r.note && <div className="text-muted-foreground">{r.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {exceptions.length > 0 && (
            <p className="px-6 py-3 text-xs text-muted-foreground">
              Only the matched amount is eliminated. A difference is never forced to zero: it stays in the consolidated figures until the entities
              reconcile it in their own books.
            </p>
          )}
        </CardContent>
      </Card>

      {entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Elimination entries (computed, not posted to any ledger)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {entries.map((e) => (
              <div key={e.id} className="text-sm">
                <p className="font-medium">{e.description}</p>
                <ul className="mt-1 text-xs text-muted-foreground">
                  {e.lines.map((l, i) => (
                    <li key={i}>
                      {l.side === "DEBIT" ? "Dr" : "Cr"} {l.code} {l.name} — <MoneyDisplay amount={l.amount} currency={currency} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {adjustments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Manual consolidation adjustments applied</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {adjustments.map((a) => (
              <div key={a.id} className="text-sm">
                <p className="font-medium">
                  {a.description} <span className="text-xs font-normal text-muted-foreground">({a.effectiveDate.slice(0, 10)})</span>
                </p>
                <ul className="mt-1 text-xs text-muted-foreground">
                  {a.lines.map((l, i) => (
                    <li key={i}>
                      {Money.of(l.debit, "X").isPositive() ? "Dr" : "Cr"} {l.code} {l.name} —{" "}
                      <MoneyDisplay amount={Money.of(l.debit, "X").isPositive() ? l.debit : l.credit} currency={currency} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
