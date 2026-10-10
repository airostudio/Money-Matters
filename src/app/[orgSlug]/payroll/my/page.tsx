import Link from "next/link";
import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { PayslipService } from "@/domain/payroll/payslip-service";
import { LeaveService } from "@/domain/payroll/leave-service";
import { Can } from "@/components/shell/can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { cancelLeaveAction, requestLeaveAction } from "../operations-actions";

export default async function MyPayPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "payslip:read", org.slug);
  if (denied) return denied;
  const slips = await PayslipService.listMine(actor);
  const canRequest = actor.role !== "READ_ONLY";
  const leave = canRequest ? await LeaveService.list(actor, { scope: "mine" }) : [];
  const boundRequest = requestLeaveAction.bind(null, org.slug);

  return (
    <div className="max-w-4xl space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My pay and leave</h1>
        <p className="text-sm text-muted-foreground">
          Only payslips for the employee record linked to your own login appear here.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">My payslips</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {slips.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No payslips yet. Either no pay run has been posted for you, or your login is not linked to an employee record.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Pay date</th>
                  <th className="p-3">Period</th>
                  <th className="p-3 text-right">Gross</th>
                  <th className="p-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {slips.map((s) => (
                  <tr key={s.lineId} className="border-b border-border last:border-0">
                    <td className="p-3">
                      <Link href={`/${org.slug}/payroll/payslips/${s.lineId}`} className="font-medium underline">
                        {s.payDate}
                      </Link>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {s.periodStart} to {s.periodEnd}
                    </td>
                    <td className="p-3 text-right"><MoneyDisplay amount={s.grossPay} currency="AUD" /></td>
                    <td className="p-3 text-right"><MoneyDisplay amount={s.netPay} currency="AUD" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Can role={actor.role} permission="leave:request">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">My leave requests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {leave.length === 0 ? (
              <p className="text-sm text-muted-foreground">No leave requests.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1">Type</th>
                    <th className="py-1">Dates</th>
                    <th className="py-1 text-right">Hours</th>
                    <th className="py-1">Status</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {leave.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-1.5">{r.leaveType === "ANNUAL" ? "Annual" : "Personal / carer's"}</td>
                      <td className="py-1.5">
                        {r.startDate.toISOString().slice(0, 10)} to {r.endDate.toISOString().slice(0, 10)}
                      </td>
                      <td className="py-1.5 text-right">{Number(r.hours).toFixed(2)}</td>
                      <td className="py-1.5">
                        {r.status}
                        {r.appliedPayRunId ? " (deducted by a pay run)" : ""}
                        {r.decisionNote ? <span className="block text-xs text-muted-foreground">{r.decisionNote}</span> : null}
                      </td>
                      <td className="py-1.5 text-right">
                        {(r.status === "PENDING" || (r.status === "APPROVED" && !r.appliedPayRunId)) ? (
                          <form action={cancelLeaveAction.bind(null, org.slug, r.id)}>
                            <Button type="submit" size="sm" variant="outline">
                              Cancel
                            </Button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <form action={boundRequest} className="grid grid-cols-2 gap-3 border-t border-border pt-4">
              <div className="space-y-1">
                <Label htmlFor="leaveType">Leave type</Label>
                <select id="leaveType" name="leaveType" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="ANNUAL">Annual leave</option>
                  <option value="PERSONAL">Personal / carer&apos;s leave</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="hours">Hours</Label>
                <Input id="hours" name="hours" type="number" step="0.25" min="0.25" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="startDate">From</Label>
                <Input id="startDate" name="startDate" type="date" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="endDate">To</Label>
                <Input id="endDate" name="endDate" type="date" required />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor="reason">Reason (optional)</Label>
                <Input id="reason" name="reason" />
              </div>
              <div className="col-span-2">
                <Button type="submit">Request leave</Button>
              </div>
              <p className="col-span-2 text-xs text-muted-foreground">
                You enter the hours yourself. Approved leave is deducted from your balance when the next pay run is posted.
              </p>
            </form>
          </CardContent>
        </Card>
      </Can>
    </div>
  );
}
