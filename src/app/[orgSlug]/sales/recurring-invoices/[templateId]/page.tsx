import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { ContactService } from "@/domain/contacts/contact-service";
import { AccountService } from "@/domain/accounts/account-service";
import { TaxCodeService } from "@/domain/tax/tax-code-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceLineEditor } from "@/components/sales/invoice-line-editor";
import {
  deleteRecurringTemplateAction,
  setRecurringTemplateActiveAction,
  updateRecurringTemplateAction,
} from "../../actions";

const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUALLY: "Annually",
};

export default async function RecurringTemplateDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; templateId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const template = await RecurringInvoiceService.get(actor, params.templateId);
  if (!template) notFound();

  const canManage = roleHasPermission(actor.role, "recurring_invoice:manage");

  const [customersOnly, both, accounts, taxCodes] = await Promise.all([
    ContactService.list(actor, { kind: "CUSTOMER" }),
    ContactService.list(actor, { kind: "BOTH" }),
    AccountService.list(actor),
    TaxCodeService.list(actor),
  ]);
  const customers = [...customersOnly, ...both].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const arAccounts = accounts.filter((a) => a.type === "ASSET" && a.isControlAccount);
  const arAccountFallback = accounts.filter((a) => a.type === "ASSET");
  const revenueAccounts = accounts.filter((a) => a.type === "REVENUE");

  const boundUpdate = updateRecurringTemplateAction.bind(null, org.slug, template.id);
  const boundPause = setRecurringTemplateActiveAction.bind(null, org.slug, template.id, false);
  const boundResume = setRecurringTemplateActiveAction.bind(null, org.slug, template.id, true);
  const boundDelete = deleteRecurringTemplateAction.bind(null, org.slug, template.id);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>
        <span className={template.isActive ? "text-sm text-success" : "text-sm text-muted-foreground"}>
          {template.isActive ? "Active" : "Paused/completed"}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        <Link href={`/${org.slug}/sales/customers/${template.customerContactId}`} className="hover:underline">
          {template.customer.displayName}
        </Link>{" "}
        · {FREQUENCY_LABELS[template.frequency] ?? template.frequency} · Next run{" "}
        {new Date(template.nextRunDate).toLocaleDateString("en-AU")} · {template.occurrencesGenerated} generated so far
      </p>

      {searchParams.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Edit template</CardTitle>
        </CardHeader>
        <form action={boundUpdate}>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 space-y-2">
                <Label htmlFor="name">Template name</Label>
                <Input id="name" name="name" defaultValue={template.name} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerContactId">Customer</Label>
                <select
                  id="customerContactId"
                  name="customerContactId"
                  required
                  defaultValue={template.customerContactId}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="arAccountId">Accounts Receivable account</Label>
                <select
                  id="arAccountId"
                  name="arAccountId"
                  required
                  defaultValue={template.arAccountId}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {(arAccounts.length > 0 ? arAccounts : arAccountFallback).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="frequency">Frequency</Label>
                <select
                  id="frequency"
                  name="frequency"
                  defaultValue={template.frequency}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="WEEKLY">Weekly</option>
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="ANNUALLY">Annually</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="startDate">First invoice date</Label>
                <Input
                  id="startDate"
                  name="startDate"
                  type="date"
                  defaultValue={new Date(template.startDate).toISOString().slice(0, 10)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End date (optional)</Label>
                <Input
                  id="endDate"
                  name="endDate"
                  type="date"
                  defaultValue={template.endDate ? new Date(template.endDate).toISOString().slice(0, 10) : ""}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxOccurrences">Stop after N invoices (optional)</Label>
                <Input
                  id="maxOccurrences"
                  name="maxOccurrences"
                  type="number"
                  min={1}
                  defaultValue={template.maxOccurrences ?? ""}
                />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="memo">Memo</Label>
                <Input id="memo" name="memo" defaultValue={template.memo ?? ""} />
              </div>
            </div>

            <InvoiceLineEditor
              accounts={revenueAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name }))}
              taxCodes={taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate }))}
              initialLines={template.lines.map((l) => ({
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                accountId: l.accountId,
                taxCodeId: l.taxCodeId,
              }))}
            />
          </CardContent>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            {canManage && (
              <Button type="submit" variant="outline">
                Save changes
              </Button>
            )}
          </div>
        </form>
      </Card>

      {canManage && (
        <div className="flex justify-end gap-2">
          {template.occurrencesGenerated === 0 && (
            <form action={boundDelete}>
              <Button type="submit" variant="outline">
                Delete template
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
