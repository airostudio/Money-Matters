import Link from "next/link";
import { requireCurrentPractice, errorParam } from "../require-practice";
import { TASK_CATEGORIES, TaskService, type TaskView } from "@/domain/practice/task-service";
import { DeadlineService } from "@/domain/practice/deadline-service";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { STARTER_TEMPLATES } from "@/domain/practice/tax-calendar";
import { practiceRoleAtLeast } from "@/domain/practice/practice-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/practice/light-badge";
import { createTemplateAction, generateDeadlinesAction, setTaskStatusAction, toggleTemplateAction } from "../actions";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthKey(d: string) {
  return d.slice(0, 7);
}

export default async function CalendarPage({ searchParams }: { searchParams: { error?: string; notice?: string; starter?: string } }) {
  const { actor, practice } = await requireCurrentPractice();
  const isManager = practiceRoleAtLeast(practice.role, "MANAGER");
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);

  const open = await TaskService.list(actor, practice.id, { status: "open", limit: 300 });
  const dated = open.filter((t) => t.dueDate && t.dueDate <= horizon);
  const overdue = dated.filter((t) => t.dueDate! < today);
  const upcoming = dated.filter((t) => t.dueDate! >= today);
  const byMonth = new Map<string, TaskView[]>();
  for (const t of upcoming) byMonth.set(monthKey(t.dueDate!), [...(byMonth.get(monthKey(t.dueDate!)) ?? []), t]);

  const templates = await DeadlineService.listTemplates(actor, practice.id);
  const links = await ClientLinkService.list(actor, practice.id);
  const starter = STARTER_TEMPLATES[Number(searchParams.starter)];
  const error = errorParam(searchParams.error);
  const notice = typeof searchParams.notice === "string" ? searchParams.notice.slice(0, 600) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tax calendar</h1>
        <p className="text-sm text-muted-foreground">Deadlines for your clients, in the next 120 days and overdue.</p>
      </div>
      <Notice tone="warning">
        These dates are <strong>entered and maintained by your practice</strong>. Money Matters does not know any tax authority&apos;s due dates, does not prepare or lodge
        BAS/GST returns, and does not connect to the ATO — that is a later Phase 8 item. Rules you write here only do date arithmetic; always confirm the real due date at ato.gov.au.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upcoming and overdue</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {dated.length === 0 && <p className="text-sm text-muted-foreground">Nothing dated in this window. Add a recurring deadline below, then generate its tasks.</p>}
          {overdue.length > 0 && (
            <div>
              <h2 className="mb-1 text-sm font-medium text-destructive">Overdue</h2>
              <TaskList tasks={overdue} />
            </div>
          )}
          {[...byMonth.entries()].map(([key, tasks]) => (
            <div key={key}>
              <h2 className="mb-1 text-sm font-medium">
                {MONTHS[Number(key.slice(5, 7)) - 1]} {key.slice(0, 4)}
              </h2>
              <TaskList tasks={tasks} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Recurring deadline rules</CardTitle>
            <CardDescription>
              A rule is a frequency, the month a period ends, the months after it the deadline falls, and the day of that month (31 means the month&apos;s last day if shorter).
              Generating creates tasks for the next three occurrences, once each. There is no background job: press Generate when you want the next ones.
            </CardDescription>
          </div>
          {isManager && (
            <form action={generateDeadlinesAction}>
              <Button type="submit" size="sm">
                Generate next deadlines
              </Button>
            </form>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className={t.isActive ? "font-medium" : "text-muted-foreground line-through"}>{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.frequency.toLowerCase()} · period ends in {MONTHS[t.periodEndMonth - 1]} (every {t.frequency === "MONTHLY" ? "month" : t.frequency === "QUARTERLY" ? "third month from it" : "year"}) · due day {t.dueDay}, {t.dueMonthsAfter} month
                      {t.dueMonthsAfter === 1 ? "" : "s"} after · {t.clientName ?? "all / practice-wide"}
                    </p>
                  </div>
                  {isManager && (
                    <form action={toggleTemplateAction.bind(null, t.id, !t.isActive)}>
                      <Button type="submit" size="sm" variant="ghost">
                        {t.isActive ? "Deactivate" : "Activate"}
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {isManager && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New rule</CardTitle>
            <CardDescription>
              Starter suggestions (fills the form; <strong>verify against ato.gov.au</strong> and edit before saving):{" "}
              {STARTER_TEMPLATES.map((s, i) => (
                <Link key={s.name} href={`/practice/calendar?starter=${i}`} className="mr-2 text-primary underline">
                  {s.name.split(" (")[0]}
                </Link>
              ))}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={createTemplateAction} className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1 sm:col-span-3">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required maxLength={160} defaultValue={starter?.name ?? ""} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="frequency">Frequency</Label>
                <select id="frequency" name="frequency" defaultValue={starter?.rule.frequency ?? "QUARTERLY"} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="ANNUAL">Annual</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="periodEndMonth">A period ends in month</Label>
                <select id="periodEndMonth" name="periodEndMonth" defaultValue={String(starter?.rule.periodEndMonth ?? 6)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="category">Category</Label>
                <select id="category" name="category" defaultValue={starter?.category ?? "BAS"} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {TASK_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="dueMonthsAfter">Months after period end</Label>
                <Input id="dueMonthsAfter" name="dueMonthsAfter" type="number" min={0} max={12} defaultValue={starter?.rule.dueMonthsAfter ?? 1} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dueDay">Due day of that month</Label>
                <Input id="dueDay" name="dueDay" type="number" min={1} max={31} defaultValue={starter?.rule.dueDay ?? 28} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="clientOrganizationId">Client</Label>
                <select id="clientOrganizationId" name="clientOrganizationId" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">Practice-wide</option>
                  {links.map((l) => (
                    <option key={l.linkId} value={l.clientOrganizationId}>
                      {l.clientName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-3">
                <Label htmlFor="notes">Notes (optional)</Label>
                <Input id="notes" name="notes" />
              </div>
              <div className="sm:col-span-3">
                <Button type="submit">Save rule</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TaskList({ tasks }: { tasks: TaskView[] }) {
  return (
    <ul className="divide-y divide-border text-sm">
      {tasks.map((t) => (
        <li key={t.id} className="flex items-center justify-between gap-2 py-2">
          <span>
            <span className="tabular-nums text-muted-foreground">{t.dueDate}</span> · {t.title}
            {t.clientName ? <span className="text-muted-foreground"> — {t.clientName}</span> : null}
            {t.assignedName ? <span className="text-muted-foreground"> ({t.assignedName})</span> : null}
          </span>
          <form action={setTaskStatusAction.bind(null, t.id, "DONE", "/practice/calendar")}>
            <Button type="submit" size="sm" variant="outline">
              Done
            </Button>
          </form>
        </li>
      ))}
    </ul>
  );
}
