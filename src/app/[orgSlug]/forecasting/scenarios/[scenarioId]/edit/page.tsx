import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { ScenarioService } from "@/domain/forecasting/scenario-service";
import { formValuesFromParams } from "@/domain/forecasting/scenario-form";
import { SCENARIO_TYPE_LABELS } from "@/domain/forecasting/scenario-parameters";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScenarioFormFields } from "@/components/forecasting/scenario-form-fields";
import { updateScenarioAction } from "../../../actions";
import { loadScenarioFormOptions } from "../../form-options";

export default async function EditScenarioPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; scenarioId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "scenario:manage", org.slug);
  if (denied) return denied;
  const scenario = await ScenarioService.get(actor, params.scenarioId);
  if (!scenario) notFound();
  const options = await loadScenarioFormOptions(actor);
  const action = updateScenarioAction.bind(null, org.slug, scenario.id);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/forecasting/scenarios/${scenario.id}`} className="hover:underline">
            {scenario.name}
          </Link>{" "}
          / Edit
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Edit scenario: {SCENARIO_TYPE_LABELS[scenario.type]}</h1>
      </div>

      {searchParams.error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      )}

      <form action={action} className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Name</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="name">Scenario name</Label>
              <Input id="name" name="name" required maxLength={120} defaultValue={scenario.name} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Textarea id="notes" name="notes" rows={2} defaultValue={scenario.notes ?? ""} />
            </div>
          </CardContent>
        </Card>
        <ScenarioFormFields type={scenario.type} values={formValuesFromParams(scenario.type, scenario.parameters)} options={options} />
        <Button type="submit">Save changes</Button>
      </form>
    </div>
  );
}
