import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { SCENARIO_PARAM_SCHEMAS, SCENARIO_TYPE_LABELS, type ScenarioType } from "@/domain/forecasting/scenario-parameters";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScenarioFormFields } from "@/components/forecasting/scenario-form-fields";
import { createScenarioAction } from "../../actions";
import { loadScenarioFormOptions } from "../form-options";

export default async function NewScenarioPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { type?: string; error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "scenario:manage", org.slug);
  if (denied) return denied;
  const type = searchParams.type as ScenarioType | undefined;
  if (!type || !(type in SCENARIO_PARAM_SCHEMAS)) notFound();
  const options = await loadScenarioFormOptions(actor);
  const action = createScenarioAction.bind(null, org.slug, type);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/${org.slug}/forecasting/scenarios`} className="hover:underline">
            Scenarios
          </Link>{" "}
          / New
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New scenario: {SCENARIO_TYPE_LABELS[type]}</h1>
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
              <Input id="name" name="name" required maxLength={120} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Textarea id="notes" name="notes" rows={2} />
            </div>
          </CardContent>
        </Card>
        <ScenarioFormFields type={type} values={{}} options={options} />
        <Button type="submit">Save and run</Button>
      </form>
    </div>
  );
}
