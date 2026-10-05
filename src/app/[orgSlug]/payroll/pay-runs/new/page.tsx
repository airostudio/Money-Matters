import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { AccountService } from "@/domain/accounts/account-service";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createPayRunAction } from "../../actions";

export default async function NewPayRunPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "payrun:manage", org.slug);
  if (denied) return denied;

  const [accounts, employees] = await Promise.all([
    AccountService.list(actor),
    EmployeeService.list(actor, { status: "ACTIVE" }),
  ]);
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");
  const liabilityAccounts = accounts.filter((a) => a.type === "LIABILITY");

  const boundCreate = createPayRunAction.bind(null, org.slug);

  function accountSelect(name: string, options: typeof accounts) {
    return (
      <select id={name} name={name} required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
        <option value="" disabled>
          Select…
        </option>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} · {a.name}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>New pay run</CardTitle>
      </CardHeader>
      <CardContent>
        {searchParams.error ? (
          <p className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
        ) : null}
        <p className="mb-4 rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">
          PAYG withholding is computed via the ATO&apos;s acknowledged annualized-bracket approximation method, not a
          byte-for-byte implementation of the published NAT 1004 tables. Minor rounding differences from the official
          per-period lookup tables are expected and accepted under the ATO&apos;s own Schedule 1 documentation. Have a
          registered tax agent or payroll provider verify this software&apos;s output before using it for real
          employee payroll.
        </p>

        <form action={boundCreate} className="space-y-6">
          <div className="grid grid-cols-4 gap-4">
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
              <Label htmlFor="periodStart">Period start</Label>
              <Input id="periodStart" name="periodStart" type="date" required />
            </div>
            <div>
              <Label htmlFor="periodEnd">Period end</Label>
              <Input id="periodEnd" name="periodEnd" type="date" required />
            </div>
            <div>
              <Label htmlFor="payDate">Pay date</Label>
              <Input id="payDate" name="payDate" type="date" required />
            </div>
          </div>

          <div className="rounded-md border border-border p-4 space-y-3">
            <p className="text-sm font-medium">Employees to pay</p>
            {employees.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active employees yet.</p>
            ) : (
              <div className="space-y-2">
                {employees.map((e) => (
                  <div key={e.id} className="flex items-center gap-3 text-sm">
                    <input type="checkbox" name="employeeIds" value={e.id} id={`emp-${e.id}`} className="h-4 w-4" />
                    <Label htmlFor={`emp-${e.id}`} className="mb-0 flex-1">
                      {e.name} ({e.employmentBasis === "SALARY" ? "Salary" : "Hourly"}, {e.payFrequency})
                    </Label>
                    {e.employmentBasis === "HOURLY" ? (
                      <Input
                        name={`manualHours_${e.id}`}
                        type="number"
                        step="0.01"
                        placeholder={e.userId ? "Leave blank to use approved timesheet hours" : "Hours (required)"}
                        className="w-72"
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-md border border-border p-4 space-y-4">
            <p className="text-sm font-medium">GL account wiring for this run</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="wagesExpenseAccountId">Wages expense account</Label>
                {accountSelect("wagesExpenseAccountId", expenseAccounts)}
              </div>
              <div>
                <Label htmlFor="superannuationExpenseAccountId">Superannuation expense account</Label>
                {accountSelect("superannuationExpenseAccountId", expenseAccounts)}
              </div>
              <div>
                <Label htmlFor="paygWithholdingPayableAccountId">PAYG withholding payable</Label>
                {accountSelect("paygWithholdingPayableAccountId", liabilityAccounts)}
              </div>
              <div>
                <Label htmlFor="superannuationPayableAccountId">Superannuation payable</Label>
                {accountSelect("superannuationPayableAccountId", liabilityAccounts)}
              </div>
              <div>
                <Label htmlFor="netWagesPayableAccountId">Net wages payable</Label>
                {accountSelect("netWagesPayableAccountId", liabilityAccounts)}
              </div>
            </div>
          </div>

          <Button type="submit">Create draft pay run</Button>
        </form>
      </CardContent>
    </Card>
  );
}
