import { requireOrgAndActor } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createSupplierAction } from "../../actions";

export default async function NewSupplierPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { org } = await requireOrgAndActor(params.orgSlug);
  const boundCreate = createSupplierAction.bind(null, org.slug);

  return (
    <div className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>New supplier</CardTitle>
        </CardHeader>
        <form action={boundCreate}>
          <CardContent className="space-y-4">
            {searchParams.error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="displayName">Name</Label>
              <Input id="displayName" name="displayName" placeholder="Bunnings Trade Pty Ltd" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" placeholder="accounts@supplier.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" placeholder="+61 2 1234 5678" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="taxNumber">Tax number (ABN)</Label>
              <Input id="taxNumber" name="taxNumber" placeholder="11 222 333 444" />
            </div>
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button type="submit">Create supplier</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
