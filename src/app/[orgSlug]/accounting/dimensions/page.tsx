import { requireOrgAndActor } from "@/lib/session";
import { DimensionService } from "@/domain/dimensions/dimension-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  addDimensionValueAction,
  createDimensionAction,
  setDimensionActiveAction,
  setDimensionValueActiveAction,
} from "./actions";

/**
 * Admin UI for the "Universal Dimension Engine" (master spec §4) —
 * previously schema-only. See `src/domain/dimensions/dimension-service.ts`'s
 * doc comment for what this closes and what it deliberately doesn't
 * (invoice/bill line tagging, deferred to Slice 3).
 */
export default async function DimensionsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const dimensions = await DimensionService.list(actor);
  const canManage = roleHasPermission(actor.role, "dimension:manage");
  const boundCreateDimension = createDimensionAction.bind(null, org.slug);
  const boundAddValue = addDimensionValueAction.bind(null, org.slug);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dimensions</h1>
        <p className="text-sm text-muted-foreground">
          Tag journal lines with a project, location, department, or any other custom dimension (master spec §4), then
          slice the Profit &amp; Loss, Balance Sheet, and Report Builder by it. Attach a dimension to a line from{" "}
          <a href={`/${org.slug}/accounting/journals/new`} className="text-primary hover:underline">
            New journal entry
          </a>
          . Attaching a dimension to an individual invoice or bill line is not supported yet — see docs/roadmap.md.
        </p>
      </div>

      {dimensions.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-8 text-center text-sm text-muted-foreground">
            No dimensions yet. Create one below — e.g. &ldquo;Project&rdquo; or &ldquo;Location&rdquo;.
          </CardContent>
        </Card>
      ) : (
        dimensions.map((dimension) => (
          <Card key={dimension.id}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">
                {dimension.name}{" "}
                {!dimension.isActive && <span className="text-xs font-normal text-muted-foreground">(inactive)</span>}
              </CardTitle>
              {canManage && (
                <form action={setDimensionActiveAction.bind(null, org.slug, dimension.id, !dimension.isActive)}>
                  <Button type="submit" variant="ghost" size="sm">
                    {dimension.isActive ? "Deactivate" : "Reactivate"}
                  </Button>
                </form>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {dimension.values.length === 0 ? (
                <p className="text-sm text-muted-foreground">No values yet.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {dimension.values.map((value) => (
                    <li key={value.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className={value.isActive ? undefined : "text-muted-foreground line-through"}>
                        {value.label}
                      </span>
                      {canManage && (
                        <form action={setDimensionValueActiveAction.bind(null, org.slug, value.id, !value.isActive)}>
                          <Button type="submit" variant="ghost" size="sm">
                            {value.isActive ? "Deactivate" : "Reactivate"}
                          </Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canManage && (
                <form action={boundAddValue} className="flex items-end gap-2">
                  <input type="hidden" name="dimensionId" value={dimension.id} />
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`label-${dimension.id}`} className="text-xs">
                      Add value
                    </Label>
                    <Input id={`label-${dimension.id}`} name="label" placeholder="e.g. Website Rebuild" required />
                  </div>
                  <Button type="submit" size="sm" variant="outline">
                    Add
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        ))
      )}

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New dimension</CardTitle>
          </CardHeader>
          <form action={boundCreateDimension}>
            <CardContent className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Project" required />
            </CardContent>
            <div className="flex justify-end border-t border-border px-6 py-4">
              <Button type="submit">Create dimension</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
