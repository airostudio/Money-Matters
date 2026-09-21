import { requireOrgAndActor } from "@/lib/session";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { AccountService } from "@/domain/accounts/account-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createTaxCodeAction } from "./actions";

export default async function TaxCodesPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const taxCodes = await TaxCodeService.list(actor);
  const accounts = await AccountService.list(actor);
  const liabilityAccounts = accounts.filter((a) => a.type === "LIABILITY");
  const boundCreate = createTaxCodeAction.bind(null, org.slug);

  return (
    <div className="max-w-2xl space-y-6">
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
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {taxCodes.map((tc) => {
                  const payableAccount = accounts.find((a) => a.id === tc.payableAccountId);
                  return (
                    <tr key={tc.id}>
                      <td className="px-6 py-2.5 font-mono text-xs">{tc.code}</td>
                      <td className="px-6 py-2.5">{tc.name}</td>
                      <td className="px-6 py-2.5 text-muted-foreground">{tc.jurisdiction}</td>
                      <td className="px-6 py-2.5 text-right">{(Number(tc.rate) * 100).toFixed(2)}%</td>
                      <td className="px-6 py-2.5 text-muted-foreground">
                        {payableAccount ? `${payableAccount.code} · ${payableAccount.name}` : "Not configured"}
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
          </CardContent>
          <div className="flex justify-end border-t border-border px-6 py-4">
            <Button type="submit">Add tax code</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
