import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { ScenarioService } from "@/domain/forecasting/scenario-service";
import { SCENARIO_TYPE_LABELS, type ScenarioType } from "@/domain/forecasting/scenario-parameters";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const TYPE_DESCRIPTIONS: Record<ScenarioType, string> = {
  HIRE_EMPLOYEE: "Salary, on-costs and start date, with optional extra revenue — effect on profit, cash, runway and break-even.",
  PRICE_CHANGE: "A price rise or cut on everything or a chosen set, with an explicit volume assumption.",
  LOSE_CUSTOMER: "Lose your largest customer (or any one) — revenue, margin where cost data exists, and cash runway.",
};

export default async function ScenariosPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const scenarios = await ScenarioService.list(actor);
  const canManage = roleHasPermission(actor.role, "scenario:manage");

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Scenarios</h1>
        <p className="text-sm text-muted-foreground">
          What-if modelling (master spec §37). A saved scenario is a saved question — each time you open it, it is re-run against your current ledger. Nothing here is ever
          posted. Best / Expected / Worst differ only by assumptions you can see and edit; they are not predictions.
        </p>
      </div>

      {canManage && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(Object.keys(SCENARIO_TYPE_LABELS) as ScenarioType[]).map((type) => (
            <Card key={type}>
              <CardHeader>
                <CardTitle className="text-base">{SCENARIO_TYPE_LABELS[type]}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">{TYPE_DESCRIPTIONS[type]}</p>
                <Button asChild size="sm">
                  <Link href={`/${org.slug}/forecasting/scenarios/new?type=${type}`}>
                    <Plus /> New
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Saved scenarios</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {scenarios.length === 0 ? (
            <p className="p-6 pt-0 text-sm text-muted-foreground">No scenarios yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Type</th>
                  <th className="p-3">Updated</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/forecasting/scenarios/${s.id}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                    </td>
                    <td className="p-3 text-muted-foreground">{SCENARIO_TYPE_LABELS[s.type]}</td>
                    <td className="p-3 text-muted-foreground">{s.updatedAt.toISOString().slice(0, 10)}</td>
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
