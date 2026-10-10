import Link from "next/link";
import { requireCurrentPractice, errorParam } from "../require-practice";
import { TASK_CATEGORIES, TaskService } from "@/domain/practice/task-service";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { PracticeService } from "@/domain/practice/practice-service";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/practice/light-badge";
import { createTaskAction, setTaskStatusAction } from "../actions";

export default async function TasksPage({ searchParams }: { searchParams: { error?: string; notice?: string; show?: string; mine?: string } }) {
  const { user, actor, practice } = await requireCurrentPractice();
  const showAll = searchParams.show === "all";
  const tasks = await TaskService.list(actor, practice.id, { status: showAll ? "all" : "open", assignedUserId: searchParams.mine === "1" ? user.id : undefined });
  const links = await ClientLinkService.list(actor, practice.id);
  const staff = await PracticeService.listStaff(actor, practice.id);
  const error = errorParam(searchParams.error);
  const today = new Date().toISOString().slice(0, 10);
  const back = "/practice/tasks";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
        <p className="text-sm text-muted-foreground">
          Your practice&apos;s own to-do list. Tasks are internal — a client never sees them — and are kept even if a client ends the link.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}

      <div className="flex flex-wrap gap-2 text-sm">
        <Link href="/practice/tasks" className={`rounded-md border px-3 py-1.5 ${!showAll && !searchParams.mine ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
          Open
        </Link>
        <Link href="/practice/tasks?mine=1" className={`rounded-md border px-3 py-1.5 ${searchParams.mine ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
          Assigned to me
        </Link>
        <Link href="/practice/tasks?show=all" className={`rounded-md border px-3 py-1.5 ${showAll ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
          Including done
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          {tasks.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No tasks.</p>
          ) : (
            <ul className="divide-y divide-border">
              {tasks.map((t) => {
                const overdue = t.dueDate !== null && t.dueDate < today && (t.status === "OPEN" || t.status === "IN_PROGRESS");
                return (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 text-sm">
                    <div className="min-w-0">
                      <p className={t.status === "DONE" || t.status === "CANCELLED" ? "text-muted-foreground line-through" : "font-medium"}>{t.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.category} · {t.priority.toLowerCase()} priority
                        {t.clientName ? ` · ${t.clientName}` : ""}
                        {t.assignedName ? ` · ${t.assignedName}` : " · unassigned"}
                        {t.dueDate ? ` · due ` : ""}
                        {t.dueDate && <span className={overdue ? "font-medium text-destructive" : ""}>{t.dueDate}{overdue ? " (overdue)" : ""}</span>}
                        {t.fromTemplate ? " · from tax calendar" : ""}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      {t.status === "OPEN" && (
                        <form action={setTaskStatusAction.bind(null, t.id, "IN_PROGRESS", back)}>
                          <Button type="submit" size="sm" variant="ghost">
                            Start
                          </Button>
                        </form>
                      )}
                      {(t.status === "OPEN" || t.status === "IN_PROGRESS") && (
                        <form action={setTaskStatusAction.bind(null, t.id, "DONE", back)}>
                          <Button type="submit" size="sm" variant="outline">
                            Done
                          </Button>
                        </form>
                      )}
                      {(t.status === "DONE" || t.status === "CANCELLED") && (
                        <form action={setTaskStatusAction.bind(null, t.id, "OPEN", back)}>
                          <Button type="submit" size="sm" variant="ghost">
                            Reopen
                          </Button>
                        </form>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New task</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={createTaskAction} className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" name="title" required maxLength={200} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="clientOrganizationId">Client (optional)</Label>
              <select id="clientOrganizationId" name="clientOrganizationId" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">No client</option>
                {links.map((l) => (
                  <option key={l.linkId} value={l.clientOrganizationId}>
                    {l.clientName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="assignedUserId">Assign to</Label>
              <select id="assignedUserId" name="assignedUserId" defaultValue={user.id} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.userId} value={s.userId}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dueDate">Due date</Label>
              <Input id="dueDate" name="dueDate" type="date" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="category">Category</Label>
              <select id="category" name="category" defaultValue="OTHER" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                {TASK_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="priority">Priority</Label>
              <select id="priority" name="priority" defaultValue="NORMAL" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Add task</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
