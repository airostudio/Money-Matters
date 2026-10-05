import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { Can } from "@/components/shell/can";
import { EmployeeService } from "@/domain/payroll/employee-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function EmployeesPage({ params }: { params: { orgSlug: string } }) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const employees = await EmployeeService.list(actor);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          <p className="text-sm text-muted-foreground">
            Payroll records — tax file numbers and bank details are masked unless your role can manage payroll.
          </p>
        </div>
        <Can role={actor.role} permission="employee:manage">
          <Button asChild size="sm">
            <Link href={`/${org.slug}/payroll/employees/new`}>
              <Plus /> Add employee
            </Link>
          </Button>
        </Can>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All employees</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {employees.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No employees yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Name</th>
                  <th className="p-3">Basis</th>
                  <th className="p-3">Pay frequency</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Annual leave (hrs)</th>
                  <th className="p-3 text-right">Personal leave (hrs)</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/payroll/employees/${e.id}`} className="font-medium hover:underline">
                        {e.name}
                      </Link>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {e.employmentBasis === "SALARY" ? `Salary ($${e.annualSalary}/yr)` : `Hourly ($${e.hourlyRate}/hr)`}
                    </td>
                    <td className="p-3 text-muted-foreground">{e.payFrequency}</td>
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          e.status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {e.status}
                      </span>
                    </td>
                    <td className="p-3 text-right">{Number(e.annualLeaveBalanceHours).toFixed(2)}</td>
                    <td className="p-3 text-right">{Number(e.personalLeaveBalanceHours).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
