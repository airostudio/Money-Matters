import Link from "next/link";
import { Plus, RefreshCw } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { generateDueInvoicesAction } from "../actions";

const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUALLY: "Annually",
};

export default async function RecurringInvoicesPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string; generated?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const templates = await RecurringInvoiceService.list(actor);
  const canManage = roleHasPermission(actor.role, "recurring_invoice:manage");
  const now = new Date();

  const boundGenerate = generateDueInvoicesAction.bind(null, org.slug);
  const dueCount = templates.filter((t) => t.isActive && new Date(t.nextRunDate) <= now).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Recurring invoices</h1>
          <p className="text-sm text-muted-foreground">
            Templates that generate a draft invoice for review — nothing is ever auto-posted.
          </p>
        </div>
        {canManage && (
          <Button asChild size="sm">
            <Link href={`/${org.slug}/sales/recurring-invoices/new`}>
              <Plus /> New template
            </Link>
          </Button>
        )}
      </div>

      {searchParams.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}
      {searchParams.generated !== undefined && (
        <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
          {searchParams.generated === "0"
            ? "No invoices were due."
            : `Generated ${searchParams.generated} draft invoice(s). Review and post them from Invoices.`}
        </p>
      )}

      {canManage && (
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div className="text-sm">
              <p className="font-medium">Generate due invoices</p>
              <p className="text-muted-foreground">
                {dueCount > 0
                  ? `${dueCount} template(s) have a due date on or before today.`
                  : "No templates are due right now."}{" "}
                This is a manually-triggered action — see docs/roadmap.md for why there&rsquo;s no automatic schedule yet.
              </p>
            </div>
            <form action={boundGenerate}>
              <Button type="submit" variant={dueCount > 0 ? "default" : "outline"}>
                <RefreshCw /> Generate due invoices
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {templates.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">No recurring invoice templates yet.</CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Template</th>
                  <th className="px-6 py-2 font-medium">Customer</th>
                  <th className="px-6 py-2 font-medium">Frequency</th>
                  <th className="px-6 py-2 font-medium">Next run</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 text-right font-medium">Generated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/sales/recurring-invoices/${t.id}`} className="font-medium hover:underline">
                        {t.name}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5">{t.customer.displayName}</td>
                    <td className="px-6 py-2.5">{FREQUENCY_LABELS[t.frequency] ?? t.frequency}</td>
                    <td className="px-6 py-2.5 text-muted-foreground">
                      {new Date(t.nextRunDate) <= now && t.isActive ? (
                        <span className="font-medium text-foreground">
                          Due since {new Date(t.nextRunDate).toLocaleDateString("en-AU")}
                        </span>
                      ) : (
                        new Date(t.nextRunDate).toLocaleDateString("en-AU")
                      )}
                    </td>
                    <td className="px-6 py-2.5">
                      <span className={t.isActive ? "text-success" : "text-muted-foreground"}>
                        {t.isActive ? "Active" : "Paused/completed"}
                      </span>
                    </td>
                    <td className="px-6 py-2.5 text-right">{t.occurrencesGenerated}</td>
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
