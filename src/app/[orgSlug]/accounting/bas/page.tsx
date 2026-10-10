import Link from "next/link";
import { Can } from "@/components/shell/can";
import { deniedViewUnless } from "@/lib/permission-gate";
import { requireOrgAndActor } from "@/lib/session";
import { BasService } from "@/domain/tax/bas-service";
import { BAS_DISCLAIMER } from "@/domain/tax/bas-calculations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createBasDraftAction } from "./actions";

const SELECT = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export default async function BasListPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "bas:read", org.slug);
  if (denied) return denied;
  const statements = await BasService.list(actor);
  const boundCreate = createBasDraftAction.bind(null, org.slug);
  const year = new Date().getUTCFullYear();

  return (
    <div className="max-w-4xl space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">BAS / GST preparation</h1>
        <p className="text-sm text-muted-foreground">
          Prepare a Business Activity Statement worksheet from your posted invoices, bills, credits, expense claims and
          pay runs.
        </p>
      </div>
      <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">{BAS_DISCLAIMER}</p>

      <Card>
        <CardContent className="p-0">
          {statements.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-muted-foreground">No BAS worksheets prepared yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2 font-medium">Period</th>
                  <th className="px-6 py-2 font-medium">Frequency</th>
                  <th className="px-6 py-2 font-medium">Status</th>
                  <th className="px-6 py-2 font-medium">Finalised</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {statements.map((s) => (
                  <tr key={s.id}>
                    <td className="px-6 py-2.5">
                      <Link href={`/${org.slug}/accounting/bas/${s.id}`} className="font-medium hover:underline">
                        {s.periodStart.toISOString().slice(0, 10)} to {s.periodEnd.toISOString().slice(0, 10)}
                      </Link>
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground">{s.frequency}</td>
                    <td className="px-6 py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          s.status === "FINALISED" ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
                        }`}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-6 py-2.5 text-muted-foreground">
                      {s.finalisedAt ? s.finalisedAt.toISOString().slice(0, 10) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Can role={actor.role} permission="bas:manage">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Prepare a new BAS worksheet</CardTitle>
          </CardHeader>
          <form action={boundCreate}>
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="frequency">Reporting frequency</Label>
                <select id="frequency" name="frequency" className={SELECT} defaultValue="QUARTERLY">
                  <option value="QUARTERLY">Quarterly (calendar quarters)</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="basis">Basis</Label>
                <select id="basis" name="basis" className={SELECT} defaultValue="ACCRUAL">
                  <option value="ACCRUAL">Accrual (invoice / bill basis)</option>
                  <option value="CASH">Cash basis (not supported - refused)</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="year">Year</Label>
                <Input id="year" name="year" type="number" defaultValue={year} min="2000" max="2100" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="index">Quarter (1-4) or month (1-12)</Label>
                <Input id="index" name="index" type="number" defaultValue="1" min="1" max="12" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="periodStart">Or a custom start date</Label>
                <Input id="periodStart" name="periodStart" type="date" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="periodEnd">Custom end date</Label>
                <Input id="periodEnd" name="periodEnd" type="date" />
              </div>
              <div className="col-span-2 space-y-2">
                <Label htmlFor="note">Note (optional)</Label>
                <Input id="note" name="note" placeholder="e.g. for review by our BAS agent" />
              </div>
              <p className="col-span-2 text-xs text-muted-foreground">
                Calendar quarters are Jan-Mar, Apr-Jun, Jul-Sep and Oct-Dec. Your ATO lodgement frequency and due dates
                are set by the ATO and are not modelled here.
              </p>
            </CardContent>
            <div className="flex justify-end border-t border-border px-6 py-4">
              <Button type="submit">Prepare draft</Button>
            </div>
          </form>
        </Card>
      </Can>
    </div>
  );
}
