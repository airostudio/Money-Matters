import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { AccountService } from "@/domain/accounts/account-service";
import { FixedAssetService } from "@/domain/fixed-assets/fixed-asset-service";
import { FixedAssetRegisterService } from "@/domain/fixed-assets/fixed-asset-register-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { disposeAssetAction, updateAssetDetailsAction, writeOffAssetAction } from "../actions";

export default async function FixedAssetDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; assetId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const asset = await FixedAssetService.get(actor, params.assetId);
  if (!asset) notFound();

  const canManage = roleHasPermission(actor.role, "fixed_asset:manage");
  const isActive = asset.status === "ACTIVE";

  const [accounts, schedule] = await Promise.all([
    isActive && canManage ? AccountService.list(actor) : Promise.resolve([]),
    FixedAssetRegisterService.getDepreciationSchedule(actor, asset.id).catch(() => []),
  ]);
  const assetAccounts = accounts.filter((a) => a.type === "ASSET");
  const anyAccounts = accounts;

  const netBookValue = (Number(asset.acquisitionCost) - Number(asset.accumulatedDepreciation)).toFixed(4);

  const boundUpdateDetails = updateAssetDetailsAction.bind(null, org.slug, asset.id);
  const boundDispose = disposeAssetAction.bind(null, org.slug, asset.id);
  const boundWriteOff = writeOffAssetAction.bind(null, org.slug, asset.id);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{asset.name}</h1>
        <p className="text-sm text-muted-foreground">
          {asset.status} — acquired {new Date(asset.acquisitionDate).toLocaleDateString()}
        </p>
      </div>

      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Financials</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-muted-foreground">Acquisition cost</p>
            <p className="text-lg font-medium">
              <MoneyDisplay amount={asset.acquisitionCost} currency={org.baseCurrency} />
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Accumulated depreciation</p>
            <p className="text-lg font-medium">
              <MoneyDisplay amount={asset.accumulatedDepreciation} currency={org.baseCurrency} />
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Net book value</p>
            <p className="text-lg font-medium">
              <MoneyDisplay amount={netBookValue} currency={org.baseCurrency} />
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Useful life</p>
            <p className="text-lg font-medium">{asset.usefulLifeMonths} months</p>
          </div>
          {asset.disposedAt && (
            <>
              <div>
                <p className="text-muted-foreground">Disposed</p>
                <p className="text-lg font-medium">{new Date(asset.disposedAt).toLocaleDateString()}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Proceeds</p>
                <p className="text-lg font-medium">
                  <MoneyDisplay amount={asset.disposalProceeds ?? "0"} currency={org.baseCurrency} />
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Gain / (loss)</p>
                <p className="text-lg font-medium">
                  <MoneyDisplay amount={asset.disposalGainLoss ?? "0"} currency={org.baseCurrency} />
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={boundUpdateDetails} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" required defaultValue={asset.name} />
                </div>
                <div>
                  <Label htmlFor="description">Description</Label>
                  <Input id="description" name="description" defaultValue={asset.description ?? ""} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="locationReference">Location</Label>
                  <Input id="locationReference" name="locationReference" defaultValue={asset.locationReference ?? ""} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    A plain editable field — there is no tracked transfer workflow in this slice.
                  </p>
                </div>
                <div>
                  <Label htmlFor="serialNumber">Serial number</Label>
                  <Input id="serialNumber" name="serialNumber" defaultValue={asset.serialNumber ?? ""} />
                </div>
              </div>
              <Button type="submit" variant="outline">
                Save details
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {isActive && canManage && (
        <div className="grid grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Dispose (sale)</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={boundDispose} className="space-y-4">
                <div>
                  <Label htmlFor="disposalDate">Disposal date</Label>
                  <Input id="disposalDate" name="disposalDate" type="date" required />
                </div>
                <div>
                  <Label htmlFor="proceeds">Proceeds received</Label>
                  <Input id="proceeds" name="proceeds" type="number" step="0.01" required placeholder="0.00" />
                </div>
                <div>
                  <Label htmlFor="proceedsAccountId">Proceeds account</Label>
                  <select
                    id="proceedsAccountId"
                    name="proceedsAccountId"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="" disabled>
                      Select…
                    </option>
                    {assetAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="gainLossAccountId">Gain/loss on disposal account</Label>
                  <select
                    id="gainLossAccountId"
                    name="gainLossAccountId"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="" disabled>
                      Select…
                    </option>
                    {anyAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">
                  This is one-way — a mistaken disposal is corrected with a manual journal, never by editing this
                  event.
                </p>
                <Button type="submit" variant="destructive">
                  Dispose asset
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Write off (no proceeds)</CardTitle>
            </CardHeader>
            <CardContent>
              <form action={boundWriteOff} className="space-y-4">
                <div>
                  <Label htmlFor="disposalDate2">Write-off date</Label>
                  <Input id="disposalDate2" name="disposalDate" type="date" required />
                </div>
                <div>
                  <Label htmlFor="lossAccountId">Loss account</Label>
                  <select
                    id="lossAccountId"
                    name="lossAccountId"
                    required
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="" disabled>
                      Select…
                    </option>
                    {anyAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground">
                  The full remaining net book value (<MoneyDisplay amount={netBookValue} currency={org.baseCurrency} />)
                  posts as a loss. One-way, same as disposal.
                </p>
                <Button type="submit" variant="destructive">
                  Write off asset
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Depreciation schedule</CardTitle>
          <p className="text-sm text-muted-foreground">
            Straight-line, month by month, projected to the end of useful life.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {schedule.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No schedule to show.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3">Period</th>
                    <th className="p-3 text-right">Amount</th>
                    <th className="p-3 text-right">Accum. depreciation</th>
                    <th className="p-3 text-right">Net book value</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.map((row) => (
                    <tr key={row.periodStart} className="border-b border-border last:border-0">
                      <td className="p-3">
                        {row.periodStart} – {row.periodEnd}
                      </td>
                      <td className="p-3 text-right">
                        <MoneyDisplay amount={row.amount} currency={org.baseCurrency} />
                      </td>
                      <td className="p-3 text-right">
                        <MoneyDisplay amount={row.accumulatedDepreciationAfter} currency={org.baseCurrency} />
                      </td>
                      <td className="p-3 text-right">
                        <MoneyDisplay amount={row.netBookValueAfter} currency={org.baseCurrency} />
                      </td>
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
