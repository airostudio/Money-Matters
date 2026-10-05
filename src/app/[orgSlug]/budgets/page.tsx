import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { Can } from "@/components/shell/can";
import { BudgetService } from "@/domain/budgeting/budget-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  ACTIVE: "bg-emerald-500/10 text-emerald-600",
  ARCHIVED: "bg-destructive/10 text-destructive",
};

const TYPE_LABELS: Record<string, string> = {
  BASELINE: "Baseline",
  REVISED_FORECAST: "Revised Forecast",
  ROLLING_FORECAST: "Rolling Forecast",
};

function formatDate(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

export default async function BudgetsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const budgets = await BudgetService.list(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Budgets</h1>
          <p className="text-sm text-muted-foreground">
            Baseline budgets, revised forecasts and rolling forecasts (master spec §36).
          </p>
        </div>
        <Can role={actor.role} permission="budget:manage">
          <Button asChild size="sm">
            <Link href={`/${org.slug}/budgets/new`}>
              <Plus /> New budget
            </Link>
          </Button>
        </Can>
      </div>

      <Card>
        <CardContent className="p-0">
          {budgets.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No budgets yet. Create a baseline budget to start planning, or to see Budget vs. Actual reporting and
              the Management Pack&apos;s budget section.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Type</th>
                  <th className="p-3">Period</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/budgets/${b.id}`} className="font-medium hover:underline">
                        {b.name}
                      </Link>
                    </td>
                    <td className="p-3 text-muted-foreground">{TYPE_LABELS[b.type] ?? b.type}</td>
                    <td className="p-3 text-muted-foreground">
                      {formatDate(b.periodStart)} – {formatDate(b.periodEnd)}
                    </td>
                    <td className="p-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[b.status] ?? ""}`}>
                        {b.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
