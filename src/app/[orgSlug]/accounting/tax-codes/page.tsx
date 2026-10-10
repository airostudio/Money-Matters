import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { AccountService } from "@/domain/accounts/account-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { classifyTaxCodeAction, createTaxCodeAction } from "./actions";

const TREATMENT_OPTIONS: Array<[string, string]> = [
  ["TAXABLE", "Taxable (GST charged / claimed)"],
  ["GST_FREE", "GST-free"],
  ["EXPORT", "Export (GST-free)"],
  ["INPUT_TAXED", "Input-taxed"],
  ["NOT_REPORTED", "Not reported on BAS"],
];

export default async function TaxCodesPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "tax_code:manage", org.slug);
  if (denied) return denied;
  const taxCodes = await TaxCodeService.list(actor);
  const accounts = await AccountService.list(actor);
  const liabilityAccounts = accounts.filter((a) => a.type === "LIABILITY");
  const assetAccounts = accounts.filter((a) => a.type === "ASSET");
  const boundCreate = createTaxCodeAction.bind(null, org.slug);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tax Codes</h1>
        <p className="text-sm text-muted-foreground">
          Versioned by jurisdiction and effective date — see docs/database.md.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {taxCodes.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">No tax codes yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Code</th>
                  <th className="px-6 py-2 font-medium">Name</th>
                  <th className="px-6 py-2 font-medium">Jurisdiction</th>
                  <th className="px-6 py-2 text-right font-medium">Rate</th>
                  <th className="px-6 py-2 font-medium">Payable account</th>
                  <th className="px-6 py-2 font-medium">Receivable account</th>
                  <th className="px-6 py-2 font-medium">BAS treatment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {taxCodes.map((tc) => {
                  const payableAccount = accounts.find((a) => a.id === tc.payableAccountId);
                  const receivableAccount = accounts.find((a) => a.id === tc.receivableAccountId);
                  return (
                    <tr key={tc.id}>
                      <td className="px-6 py-2.5 font-mono text-xs">{tc.code}</td>
                      <td className="px-6 py-2.5">{tc.name}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">{tc.jurisdiction}</td>
                      <td className="px-6 py-2.5 text-right">{(Number(tc.rate) * 100).toFixed(2)}%</td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {payableAccount ? `${payableAccount.code} · ${payableAccount.name}` : "Not configured"}
                      </td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {receivableAccount ? `${receivableAccount.code} · ${receivableAccount.name}` : "Not configured"}
                      </td>
                      <td className="px-6 py-2.5">
                        <form action={classifyTaxCodeAction.bind(null, org.slug, tc.id)} className="flex items-center gap-2">
                          <select
                            name="basTreatment"
                            defaultValue={tc.basTreatment ?? ""}
                            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                          >
                            <option value="">Unclassified</option>
                            {TREATMENT_OPTIONS.map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </select>
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" name="basCapital" defaultChecked={tc.basCapital} /> capital
                          </label>
                          <Button type="submit" size="sm" variant="outline">
                            Save
                          </Button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New tax code</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="code">Code</Label>
              <Input id="code" name="code" placeholder="GST" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="jurisdiction">Jurisdiction</Label>
              <Input id="jurisdiction" name="jurisdiction" placeholder="AU" required />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Goods and Services Tax" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ratePercent">Rate (%)</Label>
              <Input id="ratePercent" name="ratePercent" type="number" step="0.01" min="0" max="100" placeholder="10" required />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="payableAccountId">Payable account (for invoicing)</Label>
              <select
                id="payableAccountId"
                name="payableAccountId"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Not configured yet</option>
                {liabilityAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Tax collected under this code is credited here on a posted invoice — required before this code can be used on one.
              </p>
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="receivableAccountId">Receivable account (for bills)</Label>
              <select
                id="receivableAccountId"
                name="receivableAccountId"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Not configured yet</option>
                {assetAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Tax paid under this code (input tax credit) is debited here on a posted bill — required before this code can be used on one.
              </p>
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="basTreatment">BAS treatment</Label>
              <select
                id="basTreatment"
                name="basTreatment"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">Unclassified (excluded from the BAS until classified)</option>
                {TREATMENT_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" name="basCapital" /> Purchases under this code are capital purchases (BAS label G10)
              </label>
              <p className="text-xs text-muted-foreground">
                Used only to prepare a BAS worksheet for review by a registered tax agent or BAS agent. Nothing is lodged
                with the ATO. Lines using an unclassified code are never guessed at.
              </p>
            </div>
          </CardContent>
          <div className="flex justify-end border-t border-border px-6 py-4">
            <Button type="submit">Add tax code</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
