import Link from "next/link";
import { requireCurrentPractice, errorParam } from "../require-practice";
import { WorkpaperService } from "@/domain/practice/workpaper-service";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/practice/light-badge";

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  IN_REVIEW: "bg-warning/10 text-warning",
  SIGNED_OFF: "bg-success/10 text-success",
};

export default async function WorkpapersPage({ searchParams }: { searchParams: { error?: string; status?: string } }) {
  const { actor, practice } = await requireCurrentPractice();
  const status = searchParams.status === "DRAFT" || searchParams.status === "IN_REVIEW" || searchParams.status === "SIGNED_OFF" ? searchParams.status : undefined;
  const papers = await WorkpaperService.list(actor, practice.id, { status });
  const error = errorParam(searchParams.error);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workpapers</h1>
          <p className="text-sm text-muted-foreground">
            Digital working papers: reconcile a balance-sheet account to its supporting schedule, attach evidence, record review notes and sign off. A workpaper holds a labelled
            snapshot of the client&apos;s ledger balance and <strong>never writes to the client&apos;s books</strong>.
          </p>
        </div>
        <Button asChild>
          <Link href="/practice/workpapers/new">New workpaper</Link>
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2 text-sm">
        {[["", "All"], ["DRAFT", "Draft"], ["IN_REVIEW", "In review"], ["SIGNED_OFF", "Signed off"]].map(([v, label]) => (
          <Link key={v} href={v ? `/practice/workpapers?status=${v}` : "/practice/workpapers"} className={`rounded-md border px-3 py-1.5 ${(status ?? "") === v ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
            {label}
          </Link>
        ))}
      </div>
      <Card>
        <CardContent className="p-0">
          {papers.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No workpapers yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2">Client</th>
                    <th className="px-4 py-2">Account</th>
                    <th className="px-4 py-2">As at</th>
                    <th className="px-4 py-2 text-right">Ledger balance</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Prepared by</th>
                    <th className="px-4 py-2">Open notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {papers.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-2">
                        {p.clientName}
                        {p.linkStatus && p.linkStatus !== "ACTIVE" && <span className="ml-1 text-xs text-muted-foreground">(access ended)</span>}
                      </td>
                      <td className="px-4 py-2">
                        <Link href={`/practice/workpapers/${p.id}`} className="text-primary hover:underline">
                          {p.accountCode} {p.accountName}
                        </Link>
                      </td>
                      <td className="px-4 py-2 tabular-nums">{p.periodEnd}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.ledgerBalance}</td>
                      <td className="px-4 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_STYLE[p.status]}`}>{p.status.replace("_", " ").toLowerCase()}</span> v{p.version}
                      </td>
                      <td className="px-4 py-2">{p.preparedByName}</td>
                      <td className="px-4 py-2 tabular-nums">{p.openNotes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
