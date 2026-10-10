import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createEmployeeAction } from "../../actions";

export default async function NewEmployeePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "employee:manage", org.slug);
  if (denied) return denied;
  const boundCreate = createEmployeeAction.bind(null, org.slug);

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Add an employee</CardTitle>
      </CardHeader>
      <CardContent>
        {searchParams.error ? (
          <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
        ) : null}

        <form action={boundCreate} className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required placeholder="e.g. Jamie Lee" />
            </div>
            <div>
              <Label htmlFor="startDate">Start date</Label>
              <Input id="startDate" name="startDate" type="date" required />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label htmlFor="employmentBasis">Employment basis</Label>
              <select
                id="employmentBasis"
                name="employmentBasis"
                defaultValue="SALARY"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="SALARY">Salary</option>
                <option value="HOURLY">Hourly</option>
              </select>
            </div>
            <div>
              <Label htmlFor="annualSalary">Annual salary (if salaried)</Label>
              <Input id="annualSalary" name="annualSalary" type="number" step="0.01" placeholder="e.g. 85000.00" />
            </div>
            <div>
              <Label htmlFor="hourlyRate">Hourly rate (if hourly)</Label>
              <Input id="hourlyRate" name="hourlyRate" type="number" step="0.01" placeholder="e.g. 42.50" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label htmlFor="payFrequency">Pay frequency</Label>
              <select
                id="payFrequency"
                name="payFrequency"
                defaultValue="FORTNIGHTLY"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="FORTNIGHTLY">Fortnightly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
            <div>
              <Label htmlFor="standardHoursPerWeek">Standard hours/week</Label>
              <Input id="standardHoursPerWeek" name="standardHoursPerWeek" type="number" step="0.01" defaultValue="38.00" />
            </div>
            <div className="flex items-end gap-2 pb-1">
              <input id="taxFreeThresholdClaimed" name="taxFreeThresholdClaimed" type="checkbox" defaultChecked className="h-4 w-4" />
              <Label htmlFor="taxFreeThresholdClaimed" className="mb-0">
                Claims the tax-free threshold
              </Label>
            </div>
          </div>

          <div className="max-w-sm">
            <Label htmlFor="taxResidency">Tax residency</Label>
            <select
              id="taxResidency"
              name="taxResidency"
              defaultValue="RESIDENT"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="RESIDENT">Australian resident for tax purposes</option>
              <option value="FOREIGN_RESIDENT">Foreign resident (rates approximated, no Medicare levy)</option>
            </select>
          </div>

          <div>
            <Label htmlFor="userId">
              Linked login (user ID) — required only for an HOURLY employee whose hours should be pulled from
              approved timesheets
            </Label>
            <Input id="userId" name="userId" placeholder="Optional" />
          </div>

          <div className="rounded-md border border-dashed border-border p-4 space-y-4">
            <p className="text-sm font-medium">
              Sensitive details — stored like a password (never shown in full except to a role with employee:manage,
              never logged)
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="tfn">Tax file number</Label>
                <Input id="tfn" name="tfn" placeholder="Optional" />
              </div>
              <div>
                <Label htmlFor="bankAccountNumber">Bank account number</Label>
                <Input id="bankAccountNumber" name="bankAccountNumber" placeholder="Optional" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="bankAccountName">Bank account name</Label>
                <Input id="bankAccountName" name="bankAccountName" placeholder="Optional" />
              </div>
              <div>
                <Label htmlFor="bankBsb">BSB</Label>
                <Input id="bankBsb" name="bankBsb" placeholder="Optional" />
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border p-4 space-y-4">
            <p className="text-sm font-medium">Superannuation fund (record-keeping only — no SuperStream remittance in this version)</p>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label htmlFor="superFundName">Fund name</Label>
                <Input id="superFundName" name="superFundName" placeholder="Optional" />
              </div>
              <div>
                <Label htmlFor="superFundAbn">Fund ABN</Label>
                <Input id="superFundAbn" name="superFundAbn" placeholder="Optional" />
              </div>
              <div>
                <Label htmlFor="superMemberAccountNumber">Member account number</Label>
                <Input id="superMemberAccountNumber" name="superMemberAccountNumber" placeholder="Optional" />
              </div>
            </div>
          </div>

          <Button type="submit">Add employee</Button>
        </form>
      </CardContent>
    </Card>
  );
}
