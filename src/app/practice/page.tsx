import Link from "next/link";
import { requirePracticeUser, resolvePractice, errorParam } from "./require-practice";
import { HealthService } from "@/domain/practice/health-service";
import { PracticeService } from "@/domain/practice/practice-service";
import { ClientGroupService } from "@/domain/practice/client-group-service";
import { ClientLinkService } from "@/domain/practice/client-link-service";
import { TASK_CATEGORIES } from "@/domain/practice/task-service";
import { practiceRoleAtLeast } from "@/domain/practice/practice-access";
import { DASHBOARD_PAGE_SIZE, MAX_CLIENTS_PER_PRACTICE } from "@/domain/practice/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LightBadge, Notice } from "@/components/practice/light-badge";
import { bulkAssignAction, bulkGroupAction, bulkTaskAction, createPracticeAction, refreshAction } from "./actions";

export default async function PracticeDashboardPage({
  searchParams,
}: {
  searchParams: { page?: string; filter?: string; group?: string; mine?: string; error?: string; notice?: string };
}) {
  const { user, actor } = await requirePracticeUser();
  const { current: practice } = await resolvePractice(actor);

  if (!practice) {
    const error = errorParam(searchParams.error);
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Set up your practice</h1>
          <p className="text-sm text-muted-foreground">
            A practice is your accounting firm: its staff, its client list, its tasks and its workpapers. Any registered user can set one
            up, and you become its first partner. Setting up a practice gives you no access to anyone&apos;s books — each client must
            approve the link, and you also need to be a member of that client&apos;s organization with a suitable role.
          </p>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <Card>
          <CardContent className="pt-6">
            <form action={createPracticeAction} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="name">Practice name</Label>
                <Input id="name" name="name" required maxLength={120} placeholder="Smith & Co Accountants" />
              </div>
              <Button type="submit">Set up my practice</Button>
            </form>
          </CardContent>
        </Card>
        <p className="text-xs text-muted-foreground">Signed in as {user.email}.</p>
      </div>
    );
  }

  const page = Math.max(1, Number(searchParams.page) || 1);
  const filter = searchParams.filter === "needs" ? "NEEDS_INTERVENTION" : "ALL";
  const dash = await HealthService.dashboard(actor, practice.id, {
    page,
    filter,
    groupId: searchParams.group || undefined,
    assignedTo: searchParams.mine === "1" ? user.id : undefined,
  });
  // Sequential, each its own short transaction.
  const staff = await PracticeService.listStaff(actor, practice.id);
  const groups = await ClientGroupService.list(actor, practice.id);
  const pending = await ClientLinkService.list(actor, practice.id, { statuses: ["PENDING"] });
  const isManager = practiceRoleAtLeast(practice.role, "MANAGER");
  const error = errorParam(searchParams.error);
  const notice = typeof searchParams.notice === "string" ? searchParams.notice.slice(0, 600) : null;
  const here = `/practice?${new URLSearchParams({ ...(filter === "NEEDS_INTERVENTION" ? { filter: "needs" } : {}), ...(searchParams.group ? { group: searchParams.group } : {}), ...(searchParams.mine ? { mine: "1" } : {}), page: String(dash.page) }).toString()}`;
  const query = (over: Record<string, string | undefined>) => {
    const base: Record<string, string> = {};
    if (filter === "NEEDS_INTERVENTION") base.filter = "needs";
    if (searchParams.group) base.group = searchParams.group;
    if (searchParams.mine) base.mine = "1";
    const merged = { ...base, ...over };
    const qs = new URLSearchParams(Object.entries(merged).filter(([, v]) => v !== undefined) as Array<[string, string]>).toString();
    return `/practice${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Practice dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Which clients need you now. Figures come from each client&apos;s own books through your own membership and role in that client, and are
          saved as a snapshot — press Refresh for fresh ones. Showing {DASHBOARD_PAGE_SIZE} clients per page, worst first (practice limit{" "}
          {MAX_CLIENTS_PER_PRACTICE} clients).
        </p>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {dash.endedDuringLoad > 0 && (
        <Notice tone="warning">
          {dash.endedDuringLoad} client{dash.endedDuringLoad === 1 ? "" : "s"} ended this practice&apos;s access and {dash.endedDuringLoad === 1 ? "was" : "were"} removed from
          the dashboard. Your tasks and workpapers for {dash.endedDuringLoad === 1 ? "it" : "them"} are kept, marked as of their snapshot date.
        </Notice>
      )}
      {dash.notAccessibleCount > 0 && (
        <Notice>
          {dash.notAccessibleCount} linked client{dash.notAccessibleCount === 1 ? " is" : "s are"} not shown because you are not a member of {dash.notAccessibleCount === 1 ? "it" : "them"}.
          A practice link never grants access to a client&apos;s books: ask the client&apos;s owner or administrator to add you as a member{" "}
          (<Link href="/practice/clients" className="underline">see Clients</Link>).
        </Notice>
      )}
      {pending.length > 0 && (
        <Notice>
          {pending.length} request{pending.length === 1 ? " is" : "s are"} waiting for the client to accept.{" "}
          <Link href="/practice/clients" className="underline">
            Check status
          </Link>
        </Notice>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={query({ filter: undefined, page: undefined })} className={`rounded-md border px-3 py-1.5 ${filter === "ALL" ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
          All clients ({dash.totalMatching})
        </Link>
        <Link href={query({ filter: "needs", page: undefined })} className={`rounded-md border px-3 py-1.5 ${filter === "NEEDS_INTERVENTION" ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
          Needs intervention
        </Link>
        <Link href={query({ mine: searchParams.mine ? undefined : "1", page: undefined })} className={`rounded-md border px-3 py-1.5 ${searchParams.mine ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
          Assigned to me
        </Link>
        {groups.map((g) => (
          <Link key={g.id} href={query({ group: searchParams.group === g.id ? undefined : g.id, page: undefined })} className={`rounded-md border px-3 py-1.5 ${searchParams.group === g.id ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-accent"}`}>
            {g.name} ({g.clientCount})
          </Link>
        ))}
      </div>

      <div className="space-y-3">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-8 px-3 py-2">
                  <span className="sr-only">Select</span>
                </th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Books</th>
                <th className="px-3 py-2">Reconciliation</th>
                <th className="px-3 py-2">BAS / Tax</th>
                <th className="px-3 py-2">Payroll</th>
                <th className="px-3 py-2">Issues</th>
                <th className="px-3 py-2">Assigned to</th>
                <th className="px-3 py-2">Snapshot</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {dash.rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                    {filter === "NEEDS_INTERVENTION" ? "Nothing needs intervention right now." : "No clients to show yet. Link a client and make sure you are a member of its organization."}
                  </td>
                </tr>
              )}
              {dash.rows.map((r) => (
                <tr key={r.clientOrganizationId} className="align-top">
                  <td className="px-3 py-3">
                    <input type="checkbox" form="bulk-form" name="clientId" value={r.clientOrganizationId} aria-label={`Select ${r.clientName}`} />
                  </td>
                  <td className="px-3 py-3">
                    <Link href={`/practice/clients/${r.clientOrganizationId}`} className="font-medium text-primary hover:underline">
                      {r.clientName}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      You are {r.viewerRole.toLowerCase().replace("_", " ")} ·{" "}
                      <Link href={`/${r.clientSlug}`} className="hover:underline">
                        open books
                      </Link>
                    </p>
                    {r.groups.length > 0 && <p className="text-xs text-muted-foreground">{r.groups.map((g) => g.name).join(", ")}</p>}
                  </td>
                  <td className="px-3 py-3">
                    <LightBadge light={r.indicators.books.light} label={r.indicators.books.label} />
                  </td>
                  <td className="px-3 py-3">
                    <LightBadge light={r.indicators.reconciliation.light} label={r.indicators.reconciliation.label} />
                  </td>
                  <td className="px-3 py-3">
                    <LightBadge light={r.indicators.tax.light} label={r.indicators.tax.label} />
                  </td>
                  <td className="px-3 py-3">
                    <LightBadge light={r.indicators.payroll.light} label={r.indicators.payroll.label} />
                  </td>
                  <td className="px-3 py-3 tabular-nums">{r.indicators.issues}</td>
                  <td className="px-3 py-3 text-xs">{r.assignedName ?? <span className="text-muted-foreground">Unassigned</span>}</td>
                  <td className="px-3 py-3 text-xs">
                    {r.snapshot ? (
                      <span className={r.snapshot.stale ? "text-warning" : "text-muted-foreground"}>as of {r.snapshot.age}{r.snapshot.stale ? " (stale)" : ""}</span>
                    ) : (
                      <span className="text-muted-foreground">never refreshed</span>
                    )}
                    <form action={refreshAction} className="mt-1">
                      <input type="hidden" name="only" value={r.clientOrganizationId} />
                      <input type="hidden" name="back" value={here} />
                      <Button type="submit" size="sm" variant="outline" aria-label={`Refresh ${r.clientName}`}>
                        Refresh
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            Page {dash.page} of {dash.totalPages}
            {dash.page > 1 && (
              <Link href={query({ page: String(dash.page - 1) })} className="rounded-md border border-border px-2 py-1 hover:bg-accent">
                Previous
              </Link>
            )}
            {dash.page < dash.totalPages && (
              <Link href={query({ page: String(dash.page + 1) })} className="rounded-md border border-border px-2 py-1 hover:bg-accent">
                Next
              </Link>
            )}
          </div>
          <form action={refreshAction}>
            <input type="hidden" name="back" value={here} />
            {dash.rows.map((r) => (
              <input key={r.clientOrganizationId} type="hidden" name="clientId" value={r.clientOrganizationId} />
            ))}
            <Button type="submit" size="sm" variant="outline" disabled={dash.rows.length === 0}>
              Refresh this page (one at a time)
            </Button>
          </form>
        </div>

        <form id="bulk-form" className="space-y-3">
          <input type="hidden" name="back" value={here} />
          <Button type="submit" size="sm" variant="secondary" formAction={refreshAction} disabled={dash.rows.length === 0}>
            Refresh selected (one at a time)
          </Button>

        {isManager && dash.rows.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bulk actions on the selected clients</CardTitle>
              <CardDescription>Up to {DASHBOARD_PAGE_SIZE} clients (one page) at a time.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Assign staff</legend>
                <select name="assigneeUserId" aria-label="Responsible staff member" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option value="">Unassigned</option>
                  {staff.map((s) => (
                    <option key={s.userId} value={s.userId}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <Button type="submit" size="sm" variant="outline" formAction={bulkAssignAction}>
                  Assign
                </Button>
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Apply a client group</legend>
                <select name="groupId" aria-label="Client group" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {groups.length === 0 && <option value="">No groups yet (create one under Clients)</option>}
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <Button type="submit" size="sm" variant="outline" formAction={bulkGroupAction} disabled={groups.length === 0}>
                  Apply group
                </Button>
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Create a task for each</legend>
                <Input name="title" placeholder="Task title" aria-label="Task title" />
                <div className="flex gap-2">
                  <Input name="dueDate" type="date" aria-label="Due date" />
                  <select name="category" aria-label="Category" defaultValue="REVIEW" className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                    {TASK_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit" size="sm" variant="outline" formAction={bulkTaskAction}>
                  Create tasks
                </Button>
              </fieldset>
            </CardContent>
          </Card>
        )}
        </form>
      </div>

      <p className="text-xs text-muted-foreground">
        BAS / Tax shows the deadline <em>your practice entered</em> (Tasks and Tax calendar) and the client&apos;s own tax-lock state. Money Matters does not yet
        prepare or lodge BAS/GST returns, or know any official due date — automated BAS preparation is a later Phase 8 item.
      </p>
    </div>
  );
}
