import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { FixedAssetClassService } from "@/domain/fixed-assets/asset-class-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAssetClassAction } from "../actions";

export default async function AssetClassesPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canManage = roleHasPermission(actor.role, "fixed_asset:manage");
  const classes = await FixedAssetClassService.list(actor);
  const boundCreate = createAssetClassAction.bind(null, org.slug);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Asset classes</h1>
        <p className="text-sm text-muted-foreground">
          A simple template per category of asset — a default depreciation method and useful life, both overridable
          when an asset is registered. Changing a class never retroactively changes an already-registered asset.
        </p>
      </div>

      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Existing classes</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {classes.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No asset classes yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Method</th>
                  <th className="p-3 text-right">Default useful life</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0">
                    <td className="p-3 font-medium">{c.name}</td>
                    <td className="p-3 text-muted-foreground">{c.defaultDepreciationMethod.toLowerCase().replace(/_/g, " ")}</td>
                    <td className="p-3 text-right">{c.defaultUsefulLifeMonths} months</td>
                    <td className="p-3 text-muted-foreground">{c.isActive ? "Active" : "Inactive"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New asset class</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={boundCreate} className="space-y-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required placeholder="e.g. Motor Vehicles" />
              </div>
              <div>
                <Label htmlFor="defaultUsefulLifeMonths">Default useful life (months)</Label>
                <Input
                  id="defaultUsefulLifeMonths"
                  name="defaultUsefulLifeMonths"
                  type="number"
                  step="1"
                  min="1"
                  required
                  placeholder="e.g. 60"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Only straight-line depreciation is supported in this slice.
                </p>
              </div>
              <Button type="submit">Create class</Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
