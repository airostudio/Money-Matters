import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { AccountService } from "@/domain/accounts/account-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createProductAction } from "../actions";

export default async function NewProductPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "product:manage", org.slug);
  if (denied) return denied;

  const [accounts, suppliersOnly, both] = await Promise.all([
    AccountService.list(actor),
    ContactService.list(actor, { kind: "SUPPLIER" }),
    ContactService.list(actor, { kind: "BOTH" }),
  ]);
  const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");
  const assetAccounts = accounts.filter((a) => a.type === "ASSET");
  const suppliers = [...suppliersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));

  const boundCreate = createProductAction.bind(null, org.slug);

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>New product</CardTitle>
      </CardHeader>
      <CardContent>
        {searchParams.error ? (
          <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
        ) : null}
        <form action={boundCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="sku">SKU</Label>
              <Input id="sku" name="sku" required placeholder="e.g. WIDGET-001" />
            </div>
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder="e.g. Blue Widget" />
            </div>
          </div>

          <div>
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" />
          </div>

          <div>
            <Label htmlFor="type">Type</Label>
            <select id="type" name="type" defaultValue="TRACKED_INVENTORY" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="TRACKED_INVENTORY">Tracked inventory (quantity + weighted-average cost)</option>
              <option value="NON_INVENTORY">Non-inventory good (sold/bought, no quantity tracking)</option>
              <option value="SERVICE">Service</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Only Tracked inventory records stock movements and posts COGS at sale time. One implicit location per
              organization — multi-warehouse tracking is not yet supported.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="sellPrice">Default sell price</Label>
              <Input id="sellPrice" name="sellPrice" type="number" step="0.01" placeholder="Optional" />
            </div>
            <div>
              <Label htmlFor="revenueAccountId">Revenue account</Label>
              <select id="revenueAccountId" name="revenueAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="" disabled>
                  Select account…
                </option>
                {revenueAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="rounded-md border border-dashed border-border p-4 space-y-4">
            <p className="text-xs font-medium text-muted-foreground">
              For Tracked inventory, set both of these. For Non-inventory/Service, set the purchase account instead.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="inventoryAssetAccountId">Inventory asset account</Label>
                <select id="inventoryAssetAccountId" name="inventoryAssetAccountId" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">—</option>
                  {assetAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cogsAccountId">COGS account</Label>
                <select id="cogsAccountId" name="cogsAccountId" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">—</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <Label htmlFor="purchaseAccountId">Purchase (expense) account — Non-inventory/Service only</Label>
              <select id="purchaseAccountId" name="purchaseAccountId" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="">—</option>
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
              <Label htmlFor="reorderPoint">Reorder point</Label>
              <Input id="reorderPoint" name="reorderPoint" type="number" step="0.01" placeholder="Optional" />
            </div>
            <div>
              <Label htmlFor="reorderQuantity">Reorder quantity</Label>
              <Input id="reorderQuantity" name="reorderQuantity" type="number" step="0.01" placeholder="Optional" />
            </div>
          </div>

          <div>
            <Label htmlFor="preferredSupplierContactId">Preferred supplier</Label>
            <select id="preferredSupplierContactId" name="preferredSupplierContactId" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">None</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </div>

          <Button type="submit">Create product</Button>
        </form>
      </CardContent>
    </Card>
  );
}
