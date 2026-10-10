import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { ContactService } from "@/domain/contacts/contact-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createProjectAction } from "../actions";

export default async function NewProjectPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "project:manage", org.slug);
  if (denied) return denied;
  const [customersOnly, both] = await Promise.all([
    ContactService.list(actor, { kind: "CUSTOMER" }),
    ContactService.list(actor, { kind: "BOTH" }),
  ]);
  const customers = [...customersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));

  const boundCreate = createProjectAction.bind(null, org.slug);

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>New project</CardTitle>
      </CardHeader>
      <CardContent>
        {searchParams.error ? (
          <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
        ) : null}
        <form action={boundCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="code">Project code</Label>
              <Input id="code" name="code" required placeholder="e.g. PROJ-001" />
            </div>
            <div>
              <Label htmlFor="name">Project name</Label>
              <Input id="name" name="name" required placeholder="e.g. Office Fitout" />
            </div>
          </div>

          <div>
            <Label htmlFor="customerContactId">Customer (optional — required before billing time)</Label>
            <select id="customerContactId" name="customerContactId" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">No customer (internal project)</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="budgetedRevenue">Budgeted revenue</Label>
              <Input id="budgetedRevenue" name="budgetedRevenue" type="number" step="0.01" defaultValue="0" />
            </div>
            <div>
              <Label htmlFor="budgetedCost">Budgeted cost</Label>
              <Input id="budgetedCost" name="budgetedCost" type="number" step="0.01" defaultValue="0" />
            </div>
          </div>

          <div>
            <Label htmlFor="defaultHourlyRate">Default hourly billing rate</Label>
            <Input id="defaultHourlyRate" name="defaultHourlyRate" type="number" step="0.01" placeholder="e.g. 150.00" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="startDate">Start date</Label>
              <Input id="startDate" name="startDate" type="date" />
            </div>
            <div>
              <Label htmlFor="endDate">End date</Label>
              <Input id="endDate" name="endDate" type="date" />
            </div>
          </div>

          <div>
            <Label htmlFor="memo">Notes</Label>
            <Input id="memo" name="memo" />
          </div>

          <Button type="submit">Create project</Button>
        </form>
      </CardContent>
    </Card>
  );
}
