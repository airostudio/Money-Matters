import { requireOrgAndActor } from "@/lib/session";
import { roleHasPermission } from "@/domain/permissions/roles";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { terminateEmployeeAction } from "../../actions";

export default async function EmployeeDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; employeeId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const employee = await EmployeeService.get(actor, params.employeeId);
  const boundTerminate = terminateEmployeeAction.bind(null, org.slug, employee.id);

  return (
    <div className="max-w-3xl space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>{employee.name}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                employee.status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
              }`}
            >
              {employee.status}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-muted-foreground">Employment basis</dt>
              <dd>
                {employee.employmentBasis === "SALARY"
                  ? `Salary — $${employee.annualSalary}/yr`
                  : `Hourly — $${employee.hourlyRate}/hr`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Pay frequency</dt>
              <dd>{employee.payFrequency}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Standard hours/week</dt>
              <dd>{employee.standardHoursPerWeek}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Tax-free threshold claimed</dt>
              <dd>{employee.taxFreeThresholdClaimed ? "Yes" : "No"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Start date</dt>
              <dd>{employee.startDate}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Termination date</dt>
              <dd>{employee.terminationDate ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Annual leave balance</dt>
              <dd>{Number(employee.annualLeaveBalanceHours).toFixed(2)} hrs</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Personal leave balance</dt>
              <dd>{Number(employee.personalLeaveBalanceHours).toFixed(2)} hrs</dd>
            </div>
          </dl>

          <div className="rounded-md border border-dashed border-border p-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Sensitive details {employee.tfn === null && employee.tfnMasked ? "(masked — your role cannot manage payroll)" : ""}
            </p>
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-muted-foreground">TFN</dt>
                <dd>{employee.tfn ?? employee.tfnMasked ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Bank account</dt>
                <dd>{employee.bankAccountNumberMasked ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Super fund</dt>
                <dd>{employee.superFundName ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Super fund ABN</dt>
                <dd>{employee.superFundAbn ?? "—"}</dd>
              </div>
            </dl>
          </div>
        </CardContent>
      </Card>

      {employee.status === "ACTIVE" && roleHasPermission(actor.role, "employee:manage") ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Terminate employment</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={boundTerminate} className="flex items-end gap-3">
              <div>
                <Label htmlFor="terminationDate">Termination date</Label>
                <Input id="terminationDate" name="terminationDate" type="date" required />
              </div>
              <Button type="submit" variant="destructive">
                Terminate
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">
              A terminated employee is excluded from every future pay run&apos;s employee picker.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
