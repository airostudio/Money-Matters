import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { ProjectService } from "@/domain/projects/project-service";
import { TimesheetService } from "@/domain/projects/timesheet-service";
import { ProjectTimeBillingService } from "@/domain/projects/project-time-billing-service";
import { ProjectProfitabilityService } from "@/domain/projects/profitability-service";
import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";
import {
  approveTimeEntryAction,
  createInvoiceFromUnbilledTimeAction,
  createManualTimeAction,
  createProjectTaskAction,
  rejectTimeEntryAction,
  setProjectStatusAction,
  startTimerAction,
  stopTimerAction,
  submitTimeEntryAction,
} from "../actions";

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; projectId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const project = await ProjectService.get(actor, params.projectId);
  if (!project) notFound();

  const canManage = roleHasPermission(actor.role, "project:manage");
  const canApprove = roleHasPermission(actor.role, "timesheet:approve");

  const [entries, profitability, runningTimer, accounts, taxCodes, unbilledPreview] = await Promise.all([
    TimesheetService.list(actor, { projectId: project.id }),
    ProjectProfitabilityService.get(actor, project.id),
    TimesheetService.getRunningTimer(actor, actor.userId),
    AccountService.list(actor),
    TaxCodeService.list(actor),
    ProjectTimeBillingService.previewUnbilled(actor, project.id).catch(() => null),
  ]);

  const arAccounts = accounts.filter((a) => a.type === "ASSET" && a.isControlAccount);
  const arAccountFallback = accounts.filter((a) => a.type === "ASSET");
  const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");

  const boundCreateTask = createProjectTaskAction.bind(null, org.slug, project.id);
  const boundCreateTime = createManualTimeAction.bind(null, org.slug, project.id);
  const boundStartTimer = startTimerAction.bind(null, org.slug, project.id);
  const boundStopTimer = stopTimerAction.bind(null, org.slug, project.id);
  const boundCreateInvoice = createInvoiceFromUnbilledTimeAction.bind(null, org.slug, project.id);
  const boundSetStatus = setProjectStatusAction.bind(null, org.slug, project.id);

  const today = new Date().toISOString().slice(0, 10);
  const inFourteenDays = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {project.code} — {project.name}
            </h1>
            <StatusBadge status={project.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {project.customer ? project.customer.displayName : "No customer (internal project)"}
          </p>
        </div>
        {canManage && project.status !== "COMPLETED" && project.status !== "CANCELLED" ? (
          <div className="flex gap-2">
            {project.status === "ACTIVE" ? (
              <form action={boundSetStatus}>
                <input type="hidden" name="status" value="ON_HOLD" />
                <Button type="submit" size="sm" variant="outline">
                  Put on hold
                </Button>
              </form>
            ) : (
              <form action={boundSetStatus}>
                <input type="hidden" name="status" value="ACTIVE" />
                <Button type="submit" size="sm" variant="outline">
                  Reactivate
                </Button>
              </form>
            )}
            <form action={boundSetStatus}>
              <input type="hidden" name="status" value="COMPLETED" />
              <Button type="submit" size="sm" variant="outline">
                Mark complete
              </Button>
            </form>
          </div>
        ) : null}
      </div>

      {/* Estimated vs Actual — master spec §22 */}
      <Card>
        <CardHeader>
          <CardTitle>Estimated vs. Actual</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2"></th>
                <th className="py-2 text-right">Estimated</th>
                <th className="py-2 text-right">Actual</th>
                <th className="py-2 text-right">Variance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="py-2">Revenue</td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.estimated.revenue} currency={project.currency} /></td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.actual.revenue} currency={project.currency} /></td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.variance.revenue} currency={project.currency} showSign /></td>
              </tr>
              <tr className="border-b border-border">
                <td className="py-2">Cost</td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.estimated.cost} currency={project.currency} /></td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.actual.cost} currency={project.currency} /></td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.variance.cost} currency={project.currency} showSign /></td>
              </tr>
              <tr className="border-b border-border font-medium">
                <td className="py-2">Profit</td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.estimated.profit} currency={project.currency} /></td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.actual.profit} currency={project.currency} /></td>
                <td className="py-2 text-right"><MoneyDisplay amount={profitability.variance.profit} currency={project.currency} showSign /></td>
              </tr>
              <tr>
                <td className="py-2">Margin</td>
                <td className="py-2 text-right">{profitability.estimated.margin ? `${(Number(profitability.estimated.margin) * 100).toFixed(1)}%` : "—"}</td>
                <td className="py-2 text-right">{profitability.actual.margin ? `${(Number(profitability.actual.margin) * 100).toFixed(1)}%` : "—"}</td>
                <td className="py-2 text-right">—</td>
              </tr>
            </tbody>
          </table>

          <div className="mt-4 space-y-1 text-sm text-muted-foreground">
            {profitability.explanations.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Billable hours logged: {profitability.billableHours} · Non-billable hours logged: {profitability.nonBillableHours}.
            Labour cost is not included in Actual Cost above — this codebase has no per-employee hourly cost rate yet,
            only a billing rate (see docs/roadmap.md). Billed labour does appear in Actual Revenue once its invoice is posted.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Tasks */}
        <Card>
          <CardHeader>
            <CardTitle>Tasks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {project.tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tasks yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2">Task</th>
                    <th className="pb-2 text-right">Budgeted hrs</th>
                    <th className="pb-2 text-right">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {project.tasks.map((t) => (
                    <tr key={t.id} className="border-t border-border">
                      <td className="py-2">{t.name}</td>
                      <td className="py-2 text-right">{t.budgetedHours ?? "—"}</td>
                      <td className="py-2 text-right">{t.billingRate ? <MoneyDisplay amount={t.billingRate} currency={project.currency} /> : "default"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {canManage ? (
              <form action={boundCreateTask} className="space-y-2 border-t border-border pt-4">
                <div className="grid grid-cols-3 gap-2">
                  <Input name="name" placeholder="Task name" required className="col-span-3" />
                  <Input name="budgetedHours" type="number" step="0.01" placeholder="Budgeted hrs" />
                  <Input name="billingRate" type="number" step="0.01" placeholder="Rate override" className="col-span-2" />
                </div>
                <Button type="submit" size="sm" variant="outline">Add task</Button>
              </form>
            ) : null}
          </CardContent>
        </Card>

        {/* Timer / manual entry */}
        <Card>
          <CardHeader>
            <CardTitle>Log time</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {runningTimer ? (
              <form action={boundStopTimer} className="flex items-center justify-between rounded-md bg-success/10 p-3">
                <span className="text-sm text-success">Timer running since {runningTimer.startedAt?.toLocaleTimeString()}</span>
                <Button type="submit" size="sm">Stop timer</Button>
              </form>
            ) : project.status === "ACTIVE" ? (
              <form action={boundStartTimer} className="flex items-center gap-2">
                <select name="taskId" className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">No task</option>
                  {project.tasks.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="billable" defaultChecked /> Billable</label>
                <Button type="submit" size="sm">Start timer</Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground">Project is not active.</p>
            )}

            {project.status === "ACTIVE" ? (
              <form action={boundCreateTime} className="space-y-2 border-t border-border pt-4">
                <div className="grid grid-cols-2 gap-2">
                  <Input name="entryDate" type="date" defaultValue={today} required />
                  <Input name="hours" type="number" step="0.01" placeholder="Hours" required />
                </div>
                <select name="taskId" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">No task</option>
                  {project.tasks.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <Input name="notes" placeholder="Notes (optional)" />
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="billable" defaultChecked /> Billable</label>
                <Button type="submit" size="sm" variant="outline">Log manual time</Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Timesheet entries */}
      <Card>
        <CardHeader>
          <CardTitle>Timesheet entries</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No time logged yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Date</th>
                  <th className="p-3">Task</th>
                  <th className="p-3 text-right">Hours</th>
                  <th className="p-3">Billable</th>
                  <th className="p-3">Status</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0">
                    <td className="p-3">{e.entryDate.toISOString().slice(0, 10)}</td>
                    <td className="p-3">{e.task?.name ?? "—"}</td>
                    <td className="p-3 text-right">{e.hours}</td>
                    <td className="p-3">{e.billable ? "Yes" : "No"}</td>
                    <td className="p-3"><StatusBadge status={e.status} /></td>
                    <td className="p-3 text-right">
                      {e.status === "DRAFT" || e.status === "REJECTED" ? (
                        <form action={submitTimeEntryAction.bind(null, org.slug, project.id, e.id)} className="inline">
                          <Button type="submit" size="sm" variant="outline">Submit</Button>
                        </form>
                      ) : null}
                      {e.status === "SUBMITTED" && canApprove ? (
                        <span className="inline-flex gap-1">
                          <form action={approveTimeEntryAction.bind(null, org.slug, project.id, e.id)} className="inline">
                            <Button type="submit" size="sm">Approve</Button>
                          </form>
                          <form action={rejectTimeEntryAction.bind(null, org.slug, project.id, e.id)} className="inline">
                            <input type="hidden" name="reason" value="Rejected" />
                            <Button type="submit" size="sm" variant="outline">Reject</Button>
                          </form>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Create invoice from unbilled time — master spec §23's integration */}
      {canManage && project.customer ? (
        <Card>
          <CardHeader>
            <CardTitle>Create invoice from unbilled time</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {unbilledPreview && Number(unbilledPreview.totalHours) > 0
                ? `${unbilledPreview.totalHours} approved, billable, un-invoiced hours ready to bill.`
                : "No approved, billable, un-invoiced time right now."}
            </p>
            {revenueAccounts.length === 0 || (arAccounts.length === 0 && arAccountFallback.length === 0) ? (
              <p className="text-sm text-muted-foreground">
                Add an Accounts Receivable and a Revenue account to your chart of accounts first.
              </p>
            ) : (
              <form action={boundCreateInvoice} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="from">From (optional)</Label>
                    <Input id="from" name="from" type="date" />
                  </div>
                  <div>
                    <Label htmlFor="to">To (optional)</Label>
                    <Input id="to" name="to" type="date" />
                  </div>
                  <div>
                    <Label htmlFor="issueDate">Issue date</Label>
                    <Input id="issueDate" name="issueDate" type="date" defaultValue={today} required />
                  </div>
                  <div>
                    <Label htmlFor="dueDate">Due date</Label>
                    <Input id="dueDate" name="dueDate" type="date" defaultValue={inFourteenDays} required />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="arAccountId">AR account</Label>
                    <select id="arAccountId" name="arAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                      {(arAccounts.length ? arAccounts : arAccountFallback).map((a) => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="revenueAccountId">Revenue account</Label>
                    <select id="revenueAccountId" name="revenueAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                      {revenueAccounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {taxCodes.length > 0 ? (
                  <div>
                    <Label htmlFor="taxCodeId">Tax code (optional)</Label>
                    <select id="taxCodeId" name="taxCodeId" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                      <option value="">No tax</option>
                      {taxCodes.map((t) => (
                        <option key={t.id} value={t.id}>{t.code} — {t.name}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <Button type="submit">Create draft invoice from unbilled time</Button>
              </form>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Link href={`/${org.slug}/projects`} className="text-sm text-muted-foreground hover:underline">
        ← Back to projects
      </Link>
    </div>
  );
}
