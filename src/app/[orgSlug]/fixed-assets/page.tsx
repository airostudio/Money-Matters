import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { Can } from "@/components/shell/can";
import { FixedAssetRegisterService } from "@/domain/fixed-assets/fixed-asset-register-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";

export default async function FixedAssetsPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const report = await FixedAssetRegisterService.getRegister(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Fixed Asset Register</h1>
          <p className="text-sm text-muted-foreground">
            Every active capitalized asset — cost, accumulated depreciation and net book value.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/${org.slug}/fixed-assets/classes`}>Asset classes</Link>
          </Button>
          <Can role={actor.role} permission="fixed_asset:manage">
            <Button asChild size="sm" variant="outline">
              <Link href={`/${org.slug}/fixed-assets/depreciation`}>Run depreciation</Link>
            </Button>
          </Can>
          <Can role={actor.role} permission="fixed_asset:manage">
            <Button asChild size="sm">
              <Link href={`/${org.slug}/fixed-assets/new`}>
                <Plus /> Register asset
              </Link>
            </Button>
          </Can>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">GL reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {report.reconciliation.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active fixed assets yet.</p>
          ) : (
            report.reconciliation.map((r) => (
              <div
                key={`${r.assetAccountId}-${r.accumulatedDepreciationAccountId}`}
                className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {r.assetAccountCode} · {r.assetAccountName} / {r.accumulatedDepreciationAccountName}
                  </p>
                  <p className="text-muted-foreground">
                    Register <MoneyDisplay amount={r.registerNetBookValue} currency={report.currency} /> vs. GL net
                    book value <MoneyDisplay amount={r.glNetBookValue} currency={report.currency} />
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    r.reconciled ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {r.reconciled ? "Reconciled" : `Mismatch: ${r.difference}`}
                </span>
              </div>
            ))
          )}
          <p className={`text-sm font-medium ${report.fullyReconciled ? "text-emerald-600" : "text-destructive"}`}>
            {report.fullyReconciled
              ? "Every fixed-asset account pair reconciles exactly."
              : "One or more accounts do not reconcile — this is a bug, not rounding."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assets</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {report.assets.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No active fixed assets.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Class</th>
                  <th className="p-3">Acquired</th>
                  <th className="p-3 text-right">Cost</th>
                  <th className="p-3 text-right">Accum. depreciation</th>
                  <th className="p-3 text-right">Net book value</th>
                </tr>
              </thead>
              <tbody>
                {report.assets.map((a) => (
                  <tr key={a.assetId} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/fixed-assets/${a.assetId}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                    </td>
                    <td className="p-3 text-muted-foreground">{a.assetClassName}</td>
                    <td className="p-3 text-muted-foreground">{a.acquisitionDate}</td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={a.acquisitionCost} currency={report.currency} />
                    </td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={a.accumulatedDepreciation} currency={report.currency} />
                    </td>
                    <td className="p-3 text-right font-medium">
                      <MoneyDisplay amount={a.netBookValue} currency={report.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="p-3" colSpan={5}>
                    Total net book value
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={report.totalNetBookValue} currency={report.currency} />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
