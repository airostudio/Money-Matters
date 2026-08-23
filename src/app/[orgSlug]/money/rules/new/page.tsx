import { requireOrgAndActor } from "@/lib/session";
import { AccountService } from "@/domain/accounts/account-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createBankRuleAction } from "../../actions";

export default async function NewBankRulePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor } = await requireOrgAndActor(params.orgSlug);
  const accounts = await AccountService.list(actor);
  const boundCreate = createBankRuleAction.bind(null, params.orgSlug);

  return (
    <div className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>New bank rule</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-4">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {searchParams.error}
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">Rule name</Label>
              <Input id="name" name="name" placeholder="Coffee to General Expenses" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="descriptionContains">When the description contains</Label>
              <Input id="descriptionContains" name="descriptionContains" placeholder="STRIPE" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="categorizedAccountId">Categorize to</Label>
              <select
                id="categorizedAccountId"
                name="categorizedAccountId"
                required
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </select>
            </div>
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Create rule</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
