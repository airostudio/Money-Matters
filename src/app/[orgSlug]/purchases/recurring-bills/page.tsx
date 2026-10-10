import Link from "next/link";
import { Plus, RefreshCw } from "lucide-react";
import { requireOrgAndActor } from "@/lib/session";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { generateDueBillsAction } from "../actions";

export default async function RecurringBillsPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { generated?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const canManage = roleHasPermission(actor.role, "recurring_bill:manage");
  const templates = await RecurringBillService.list(actor);
  const boundGenerate = generateDueBillsAction.bind(null, org.slug);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Recurring Bills</h1>
          <p className="text-sm text-muted-foreground">
            Templates for bills that repeat on a schedule — each occurrence is still a draft you review before posting.
          </p>
        </div>
        <div className="flex gap-2">
          {canManage && (
            <form action={boundGenerate}>
              <Button type="submit" variant="outline" size="sm">
                <RefreshCw /> Generate due bills
              </Button>
            </form>
          )}
          {canManage && (
            <Button asChild size="sm">
              <Link href={`/${org.slug}/purchases/recurring-bills/new`}>
                <Plus /> New template
              </Link>
            </Button>
          )}
        </div>
      </div>

      {searchParams.generated !== undefined && (
        <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">
          Generated {searchParams.generated} draft bill(s). Review and approve them from the Bills list.
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          {templates.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No recurring bill templates yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Name</th>
                  <th className="px-6 py-2 font-medium">Supplier</th>
                  <th className="px-6 py-2 font-medium">Frequency</th>
                  <th className="px-6 py-2 font-medium">Next run</th>
                  <th className="px-6 py-2 font-medium">Generated</th>
                  <th className="px-6 py-2 font-medium">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {templates.map((t) => (
                  <tr key={t.id} className="hover:bg-muted/50">
                    <td className="px-6 py-3">
                      <Link href={`/${org.slug}/purchases/recurring-bills/${t.id}`} className="font-medium hover:underline">
                        {t.name}
                      </Link>
                    </td>
                    <td className="px-6 py-3">{t.supplier.displayName}</td>
                    <td className="px-6 py-3 capitalize">{t.frequency.toLowerCase()}</td>
                    <td className="px-6 py-3">{new Date(t.nextRunDate).toLocaleDateString("en-AU")}</td>
                    <td className="px-6 py-3">{t.occurrencesGenerated}</td>
                    <td className="px-6 py-3">{t.isActive ? "Yes" : "Paused"}</td>
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
