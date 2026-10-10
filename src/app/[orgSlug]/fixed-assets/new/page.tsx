import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { AccountService } from "@/domain/accounts/account-service";
import { FixedAssetClassService } from "@/domain/fixed-assets/asset-class-service";
import { FixedAssetService } from "@/domain/fixed-assets/fixed-asset-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { registerAssetAction } from "../actions";

export default async function NewFixedAssetPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "fixed_asset:manage", org.slug);
  if (denied) return denied;

  const [accounts, assetClasses, candidateBillLines] = await Promise.all([
    AccountService.list(actor),
    FixedAssetClassService.list(actor, { isActive: true }),
    FixedAssetService.listUnregisteredAssetBillLines(actor),
  ]);
  const assetAccounts = accounts.filter((a) => a.type === "ASSET");
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");

  const boundRegister = registerAssetAction.bind(null, org.slug);

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Register a fixed asset</CardTitle>
      </CardHeader>
      <CardContent>
        {searchParams.error ? (
          <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
        ) : null}

        <form action={boundRegister} className="space-y-6">
          <div className="rounded-md border border-dashed border-border p-4 space-y-3">
            <Label htmlFor="source">Where did this asset come from?</Label>
            <select
              id="source"
              name="source"
              defaultValue="standalone"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="standalone">
                Standalone — already on the books (opening balance, manual journal, etc.)
              </option>
              <option value="bill_line">A posted bill line coded directly to the asset account</option>
            </select>
            <p className="text-xs text-muted-foreground">
              Registering never posts a journal itself. For a bill line, the bill&apos;s own existing debit already
              covers the acquisition — pick the matching account below and it will be verified to match.
            </p>
          </div>

          <div className="rounded-md border border-border p-4 space-y-4">
            <p className="text-sm font-medium">If from a posted bill line</p>
            {candidateBillLines.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No posted bill lines coded to an ASSET account are available to register yet.
              </p>
            ) : (
              <select
                id="billLineId"
                name="billLineId"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Select a bill line…</option>
                {candidateBillLines.map((l) => (
                  <option key={l.billLineId} value={l.billLineId}>
                    {l.billNumber} · {l.supplierName} · {l.description} ·{" "}
                    {l.accountCode} {l.accountName} · {l.lineAmount}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="rounded-md border border-border p-4 space-y-4">
            <p className="text-sm font-medium">If standalone</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="acquisitionDate">Acquisition date</Label>
                <Input id="acquisitionDate" name="acquisitionDate" type="date" />
              </div>
              <div>
                <Label htmlFor="acquisitionCost">Acquisition cost</Label>
                <Input id="acquisitionCost" name="acquisitionCost" type="number" step="0.01" placeholder="e.g. 12000.00" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder="e.g. Delivery Van" />
            </div>
            <div>
              <Label htmlFor="assetClassId">Asset class</Label>
              <select
                id="assetClassId"
                name="assetClassId"
                required
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="" disabled>
                  Select class…
                </option>
                {assetClasses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.defaultUsefulLifeMonths} months)
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="usefulLifeMonths">Useful life override (months)</Label>
              <Input id="usefulLifeMonths" name="usefulLifeMonths" type="number" step="1" min="1" placeholder="Default from class" />
            </div>
            <div>
              <Label htmlFor="residualValue">Residual value</Label>
              <Input id="residualValue" name="residualValue" type="number" step="0.01" placeholder="Default 0" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label htmlFor="assetAccountId">Asset (cost) account</Label>
              <select id="assetAccountId" name="assetAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
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
              <Label htmlFor="accumulatedDepreciationAccountId">Accumulated depreciation account</Label>
              <select
                id="accumulatedDepreciationAccountId"
                name="accumulatedDepreciationAccountId"
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
              <Label htmlFor="depreciationExpenseAccountId">Depreciation expense account</Label>
              <select
                id="depreciationExpenseAccountId"
                name="depreciationExpenseAccountId"
                required
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="" disabled>
                  Select…
                </option>
                {expenseAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="locationReference">Location</Label>
              <Input id="locationReference" name="locationReference" placeholder="Optional" />
            </div>
            <div>
              <Label htmlFor="serialNumber">Serial number</Label>
              <Input id="serialNumber" name="serialNumber" placeholder="Optional" />
            </div>
          </div>

          <Button type="submit">Register asset</Button>
        </form>
      </CardContent>
    </Card>
  );
}
