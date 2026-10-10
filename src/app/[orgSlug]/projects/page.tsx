import Link from "next/link";
import { Plus } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { Can } from "@/components/shell/can";
import { ProjectService } from "@/domain/projects/project-service";
import { projectStatusEnum } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { MoneyDisplay } from "@/components/accounting/money-display";

type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { status?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const statusFilter =
    searchParams.status && projectStatusEnum.enumValues.includes(searchParams.status as ProjectStatus)
      ? (searchParams.status as ProjectStatus)
      : undefined;

  const projectList = await ProjectService.list(actor, { status: statusFilter });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">Jobs, budgets, time tracking and billing.</p>
        </div>
        <Can role={actor.role} permission="project:manage">
          <Button asChild size="sm">
            <Link href={`/${org.slug}/projects/new`}>
              <Plus /> New project
            </Link>
          </Button>
        </Can>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <Link
          href={`/${org.slug}/projects`}
          className={`rounded-full px-3 py-1 ${!statusFilter ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
        >
          All
        </Link>
        {projectStatusEnum.enumValues.map((s) => (
          <Link
            key={s}
            href={`/${org.slug}/projects?status=${s}`}
            className={`rounded-full px-3 py-1 capitalize ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
          >
            {s.toLowerCase().replace(/_/g, " ")}
          </Link>
        ))}
      </div>

      {projectList.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">No projects to show.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Code</th>
                  <th className="p-3">Name</th>
                  <th className="p-3">Customer</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">Budgeted revenue</th>
                  <th className="p-3 text-right">Budgeted cost</th>
                </tr>
              </thead>
              <tbody>
                {projectList.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                    <td className="p-3">
                      <Link href={`/${org.slug}/projects/${p.id}`} className="font-medium hover:underline">
                        {p.code}
                      </Link>
                    </td>
                    <td className="p-3">{p.name}</td>
                    <td className="p-3 text-muted-foreground">{p.customer?.displayName ?? "—"}</td>
                    <td className="p-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={p.budgetedRevenue} currency={p.currency} />
                    </td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={p.budgetedCost} currency={p.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
