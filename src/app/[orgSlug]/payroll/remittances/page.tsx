import { requireOrgAndActor } from "@/lib/session";
import { deniedViewUnless } from "@/lib/permission-gate";
import { Can } from "@/components/shell/can";
import { AccountService } from "@/domain/accounts/account-service";
import { PayrollPaymentService } from "@/domain/payroll/payroll-payment-service";
import { PayrollReportService } from "@/domain/payroll/payroll-report-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { recordRemittanceAction, reversePayrollPaymentAction } from "../operations-actions";

const SELECT = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

export default async function RemittancesPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "payroll_payment:read", org.slug);
  if (denied) return denied;
  const canManage = roleHasPermission(actor.role, "payroll_payment:manage");
  const accounts = await AccountService.list(actor);
  const nameOf = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} · ${a.name}` : id;
  };
  const banks = canManage ? accounts.filter((a) => a.type === "ASSET" && a.isActive) : [];
  const now = new Date();
  const range = { from: new Date(Date.UTC(2000, 0, 1)), to: now };
  const payg = await PayrollReportService.paygSummary(actor, range);
  const sup = await PayrollReportService.superLiabilityByQuarter(actor);
  const paygPayments = await PayrollPaymentService.listRemittances(actor, "PAYG");
  const superPayments = await PayrollPaymentService.listRemittances(actor, "SUPER");

  const section = (kind: "SUPER" | "PAYG", title: string, outstanding: typeof payg.outstandingNow, payments: typeof paygPayments) => (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {kind === "SUPER"
            ? "Record-only: Money Matters has no clearing house integration and pays no fund. Record a payment you made elsewhere."
            : "Record-only: nothing is paid to the ATO from here. Record a remittance you made elsewhere."}{" "}
          Requires registered tax agent / payroll provider review.
        </p>
        {outstanding.length === 0 ? <p className="text-muted-foreground">No posted pay runs yet.</p> : null}
        {outstanding.map((o) => (
          <div key={o.liabilityAccountId} className="rounded-md border border-border p-3">
            <p className="font-medium">{nameOf(o.liabilityAccountId)}</p>
            <p>
              Accrued {o.accrued} · remitted {o.paid} · outstanding <strong>{o.outstanding}</strong>
            </p>
            {canManage && Number(o.outstanding) > 0 ? (
              <form action={recordRemittanceAction.bind(null, org.slug, kind)} className="mt-2 grid grid-cols-2 gap-2">
                <input type="hidden" name="liabilityAccountId" value={o.liabilityAccountId} />
                <div className="space-y-1">
                  <Label>Paid from</Label>
                  <select name="bankAccountId" required className={SELECT}>
                    {banks.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>Amount</Label>
                  <Input name="amount" type="number" step="0.01" min="0.01" max={o.outstanding} required />
                </div>
                <div className="space-y-1">
                  <Label>Date paid</Label>
                  <Input name="paymentDate" type="date" required />
                </div>
                <div className="space-y-1">
                  <Label>Reference</Label>
                  <Input name="reference" />
                </div>
                <div className="col-span-2">
                  <Button type="submit" size="sm">
                    Record {kind === "SUPER" ? "super payment" : "PAYG remittance"}
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        ))}
        {payments.length > 0 ? (
          <ul className="space-y-1">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {p.paymentDate.toISOString().slice(0, 10)} · {p.amount} · {p.status}
                  {p.reference ? ` · ${p.reference}` : ""}
                </span>
                {p.status === "POSTED" && canManage ? (
                  <form action={reversePayrollPaymentAction.bind(null, org.slug, p.id, "remittances")} className="flex items-center gap-1">
                    <Input name="reason" placeholder="Reason (10+ characters)" className="h-7 w-52" />
                    <Button type="submit" size="sm" variant="outline">
                      Reverse
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );

  return (
    <div className="max-w-4xl space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payroll remittances</h1>
        <p className="text-sm text-muted-foreground">
          Outstanding liabilities come from posted pay runs and the payments recorded here, not from the GL balance.
        </p>
      </div>
      <Can role={actor.role} permission="payroll_payment:read">
        {section("PAYG", "PAYG withholding", payg.outstandingNow, paygPayments)}
        {section("SUPER", "Superannuation", sup.outstandingNow, superPayments)}
      </Can>
    </div>
  );
}
