import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { Can } from "@/components/shell/can";
import { LeaveService } from "@/domain/payroll/leave-service";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { decideLeaveAction } from "../operations-actions";

export default async function LeaveApprovalsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "leave:read", org.slug);
  if (denied) return denied;
  const all = await LeaveService.list(actor, { scope: "all" });
  const pending = all.filter((r) => r.status === "PENDING");
  const rest = all.filter((r) => r.status !== "PENDING");

  return (
    <div className="max-w-5xl space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Leave requests</h1>
        <p className="text-sm text-muted-foreground">
          Approval is refused when the hours exceed the employee&apos;s balance, and nobody can decide their own request.
          Approved leave is deducted from the balance when the pay run is posted; it does not change gross pay.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Waiting for a decision ({pending.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {pending.length === 0 ? <p className="text-sm text-muted-foreground">Nothing is waiting.</p> : null}
          {pending.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium">
                {r.employeeName}: {r.leaveType === "ANNUAL" ? "annual" : "personal / carer's"} leave, {Number(r.hours).toFixed(2)} h
              </p>
              <p className="text-muted-foreground">
                {r.startDate.toISOString().slice(0, 10)} to {r.endDate.toISOString().slice(0, 10)}
                {r.reason ? ` · ${r.reason}` : ""}
              </p>
              <Can role={actor.role} permission="leave:approve">
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <form action={decideLeaveAction.bind(null, org.slug, r.id, "approve")} className="flex items-center gap-2">
                    <Input name="note" placeholder="Note (optional)" className="h-8 w-48" />
                    <Button type="submit" size="sm">
                      Approve
                    </Button>
                  </form>
                  <form action={decideLeaveAction.bind(null, org.slug, r.id, "reject")}>
                    <input type="hidden" name="note" value="" />
                    <Button type="submit" size="sm" variant="outline">
                      Reject
                    </Button>
                  </form>
                </div>
              </Can>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Decided and withdrawn</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Employee</th>
                <th className="p-3">Type</th>
                <th className="p-3">Dates</th>
                <th className="p-3 text-right">Hours</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="p-3">{r.employeeName}</td>
                  <td className="p-3">{r.leaveType === "ANNUAL" ? "Annual" : "Personal / carer's"}</td>
                  <td className="p-3">
                    {r.startDate.toISOString().slice(0, 10)} to {r.endDate.toISOString().slice(0, 10)}
                  </td>
                  <td className="p-3 text-right">{Number(r.hours).toFixed(2)}</td>
                  <td className="p-3">
                    {r.status}
                    {r.appliedPayRunId ? " (deducted)" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
