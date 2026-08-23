import { requireOrgAndActor } from "@/lib/session";
import { AccountService } from "@/domain/accounts/account-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createBankAccountAction } from "../actions";

export default async function NewBankAccountPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const assetAccounts = (await AccountService.list(actor)).filter((a) => a.type === "ASSET");
  const boundCreate = createBankAccountAction.bind(null, params.orgSlug);

  return (
    <div className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>Link a bank account</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-4">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {searchParams.error}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Everyday Account" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="glAccountId">Ledger account</Label>
              {assetAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No ASSET accounts exist yet — create one in Chart of Accounts first.
                </p>
              ) : (
                <select
                  id="glAccountId"
                  name="glAccountId"
                  required
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {assetAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-xs text-muted-foreground">
                Every reconciled transaction posts against this account.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="institutionName">Institution (optional)</Label>
                <Input id="institutionName" name="institutionName" placeholder="Commonwealth Bank" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="accountNumberLast4">Last 4 digits (optional)</Label>
                <Input id="accountNumberLast4" name="accountNumberLast4" maxLength={4} placeholder="1234" />
              </div>
            </div>
            <input type="hidden" name="currency" value={org.baseCurrency} />
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit" disabled={assetAccounts.length === 0}>
              Link account
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
