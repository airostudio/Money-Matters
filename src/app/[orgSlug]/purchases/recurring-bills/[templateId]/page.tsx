import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { deleteRecurringBillAction, setRecurringBillActiveAction } from "../../actions";

export default async function RecurringBillDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; templateId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const template = await RecurringBillService.get(actor, params.templateId);
  if (!template) notFound();

  const canManage = roleHasPermission(actor.role, "recurring_bill:manage");
  const boundPause = setRecurringBillActiveAction.bind(null, org.slug, template.id, false);
  const boundResume = setRecurringBillActiveAction.bind(null, org.slug, template.id, true);
  const boundDelete = deleteRecurringBillAction.bind(null, org.slug, template.id);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>
        <span className="text-sm text-muted-foreground">{template.isActive ? "Active" : "Paused"}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        <Link href={`/${org.slug}/purchases/suppliers/${template.supplierContactId}`} className="hover:underline">
          {template.supplier.displayName}
        </Link>{" "}
        · {template.frequency.toLowerCase()} · next run {new Date(template.nextRunDate).toLocaleDateString("en-AU")} ·{" "}
        {template.occurrencesGenerated} generated
      </p>

      {searchParams.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lines</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-border">
              {template.lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-6 py-2.5">{line.description}</td>
                  <td className="px-6 py-2.5 text-right">{Number(line.quantity)}</td>
                  <td className="px-6 py-2.5 text-right">
                    <MoneyDisplay amount={line.unitPrice} currency={template.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {canManage && (
        <div className="flex justify-end gap-2">
          {template.occurrencesGenerated === 0 && (
            <form action={boundDelete}>
              <Button type="submit" variant="outline">
                Delete
              </Button>
            </form>
          )}
          {template.isActive ? (
            <form action={boundPause}>
              <Button type="submit" variant="outline">
                Pause
              </Button>
            </form>
          ) : (
            <form action={boundResume}>
              <Button type="submit">Resume</Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
