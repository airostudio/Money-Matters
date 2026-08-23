import { accountTypeEnum } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAccountAction } from "../actions";

export default function NewAccountPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const boundCreate = createAccountAction.bind(null, params.orgSlug);

  return (
    <div className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>New account</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-4">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {searchParams.error}
              </p>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="code">Code</Label>
                <Input id="code" name="code" placeholder="1000" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="type">Type</Label>
                <select
                  id="type"
                  name="type"
                  required
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {accountTypeEnum.enumValues.map((type) => (
                    <option key={type} value={type}>
                      {type.charAt(0) + type.slice(1).toLowerCase()}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Business Bank Account" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="subType">Sub-type (optional)</Label>
              <Input id="subType" name="subType" placeholder="Bank" />
            </div>
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Create account</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
