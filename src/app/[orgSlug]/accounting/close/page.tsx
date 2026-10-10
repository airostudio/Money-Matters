import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { PeriodCloseService, type PeriodListItem } from "@/domain/close/period-close-service";
import { LOCK_DESCRIPTIONS, LOCK_LABELS, LOCK_LEVELS } from "@/domain/ledger/period-lock";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "—";
}

function progressCell(p: PeriodListItem) {
  if (p.livePercent !== null) {
    return (
      <span title="Computed live from current data">
        <strong>{p.livePercent}%</strong> <span className="text-xs text-muted-foreground">live</span>
      </span>
    );
  }
  if (p.percentAtClose !== null) {
    return (
      <span title="Taken from the checklist snapshot stored when this period was closed — not current">
        {p.percentAtClose}% <span className="text-xs text-muted-foreground">at close</span>
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">Open the checklist to compute</span>;
}

function Row({ p, orgSlug }: { p: PeriodListItem; orgSlug: string }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/40">
      <td className="p-3">
        <Link href={`/${orgSlug}/accounting/close/${p.key}`} className="font-medium hover:underline">
          {p.label}
        </Link>
        <div className="text-xs text-muted-foreground">
          {when(p.start)} – {when(p.end)}
        </div>
      </td>
      <td className="p-3">
        <StatusBadge status={p.effectiveLevel} />
        {p.effectiveLevel !== p.ownLevel && p.coveredBy.length > 0 && (
          <div className="mt-1 text-xs text-muted-foreground">via {p.coveredBy.map((c) => c.label).join(", ")}</div>
        )}
      </td>
      <td className="p-3">
        <StatusBadge status={p.closeStatus} />
        {p.closeStatus === "CLOSED" && (
          <div className="mt-1 text-xs text-muted-foreground">
            {when(p.closedAt)}
            {p.closedByName ? ` by ${p.closedByName}` : ""}
          </div>
        )}
      </td>
      <td className="p-3">{progressCell(p)}</td>
      <td className="p-3 text-muted-foreground">
        {p.signoffsDone}/{p.signoffsTotal}
      </td>
      <td className="p-3 text-right">
        <Link href={`/${orgSlug}/accounting/close/${p.key}`} className="text-primary hover:underline">
          Open
        </Link>
      </td>
    </tr>
  );
}

function Table({ rows, orgSlug }: { rows: PeriodListItem[]; orgSlug: string }) {
  return (
    <table className="w-full text-sm">
      <thead className="border-b border-border text-left text-xs text-muted-foreground">
        <tr>
          <th className="p-3">Period</th>
          <th className="p-3">Lock level</th>
          <th className="p-3">Close</th>
          <th className="p-3">Month close %</th>
          <th className="p-3" title="Manual items signed off by a person">
            Sign-offs
          </th>
          <th className="p-3" />
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <Row key={p.key} p={p} orgSlug={orgSlug} />
        ))}
      </tbody>
    </table>
  );
}

export default async function CloseListPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const periods = await PeriodCloseService.listPeriods(actor);
  const months = periods.filter((p) => p.kind === "MONTH");
  const ranges = periods.filter((p) => p.kind === "RANGE");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Month-End Close</h1>
        <p className="text-sm text-muted-foreground">
          A live checklist per month (master spec §40) and the period lock levels that protect closed books (§41). Every
          automatic check is recomputed from current data each time you open a period; manual items are explicit
          sign-offs by a named person.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table rows={months} orgSlug={org.slug} />
        </CardContent>
      </Card>

      {ranges.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Other periods</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table rows={ranges} orgSlug={org.slug} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lock levels</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {LOCK_LEVELS.map((level) => (
              <div key={level}>
                <dt className="font-medium">
                  <StatusBadge status={level} />
                </dt>
                <dd className="mt-1 text-muted-foreground">{LOCK_DESCRIPTIONS[level]}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Tax lock is a manual lock you apply and label — the platform has no tax-lodgement integration. Posted entries
            are never altered by locking or reopening; corrections are posted as new entries in an open period. Levels
            are {LOCK_LEVELS.map((l) => LOCK_LABELS[l]).join(" → ")} in increasing severity.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
