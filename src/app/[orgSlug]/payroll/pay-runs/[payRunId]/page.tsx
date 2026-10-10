import Link from "next/link";
import { Can } from "@/components/shell/can";
import { requireOrgAndActor } from "@/lib/session";
import { PayRunService } from "@/domain/payroll/pay-run-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountService } from "@/domain/accounts/account-service";
import { PayrollPaymentService } from "@/domain/payroll/payroll-payment-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { discardPayRunDraftAction, postPayRunAction } from "../../actions";
import { payNetWagesAction, reversePayRunAction, reversePayrollPaymentAction } from "../../operations-actions";

export default async function PayRunDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; payRunId: string };
  searchParams: { error?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const run = await PayRunService.get(actor, params.payRunId);
  const canSeePayments = roleHasPermission(actor.role, "payroll_payment:read");
  const payments = canSeePayments && run.status !== "DRAFT" ? await PayrollPaymentService.listForRun(actor, run.id) : [];
  const position = canSeePayments && run.status === "POSTED" ? await PayrollPaymentService.netWagesPosition(actor, run.id) : null;
  const bankAccounts =
    run.status === "POSTED" && roleHasPermission(actor.role, "payroll_payment:manage")
      ? (await AccountService.list(actor)).filter((a) => a.type === "ASSET" && a.isActive)
      : [];
  const boundPay = payNetWagesAction.bind(null, org.slug, run.id);
  const boundReverse = reversePayRunAction.bind(null, org.slug, run.id);

  const boundPost = postPayRunAction.bind(null, org.slug, run.id);
  const boundDiscard = discardPayRunDraftAction.bind(null, org.slug, run.id);

  return (
    <div className="space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Pay run: {run.periodStart} – {run.periodEnd}
          </h1>
          <p className="text-sm text-muted-foreground">Pay date {run.payDate} · {run.payFrequency}</p>
        </div>
        <div className="flex gap-2">
          <span
            className={`self-center rounded-full px-3 py-1 text-xs font-medium ${
              run.status === "POSTED"
                ? "bg-emerald-500/10 text-emerald-600"
                : run.status === "REVERSED"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-amber-500/10 text-amber-600"
            }`}
          >
            {run.status}
          </span>
          {run.status === "DRAFT" ? (
            <>
              <Can role={actor.role} permission="payrun:manage">
                <form action={boundDiscard}>
                  <Button type="submit" variant="outline" size="sm">
                    Discard draft
                  </Button>
                </form>
              </Can>
              <Can role={actor.role} permission="payrun:post">
                <form action={boundPost}>
                  <Button type="submit" size="sm">
                    Post pay run
                  </Button>
                </form>
              </Can>
            </>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link href={`/${org.slug}/payroll/pay-runs/${run.id}/stp`}>STP-shaped report</Link>
            </Button>
          )}
        </div>
      </div>

      <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">
        PAYG withholding below uses the ATO&apos;s acknowledged annualized-bracket approximation method — expect
        minor rounding differences from the official per-period lookup tables. Have a registered tax agent or
        payroll provider verify this output before relying on it for real payroll. Requires registered tax agent /
        payroll provider review; nothing here is lodged with the ATO. The &quot;super received by fund by&quot; date is a
        conservative weekday count that does not know public holidays or clearing-house time; it is not the legal deadline.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payslips</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Employee</th>
                <th className="p-3">Rule set</th>
                <th className="p-3 text-right">Hours</th>
                <th className="p-3 text-right">Gross</th>
                <th className="p-3 text-right">PAYG</th>
                <th className="p-3 text-right">Super</th>
                <th className="p-3 text-right">Net</th>
                <th className="p-3 text-right">Annual leave accrued</th>
                <th className="p-3 text-right">Personal leave accrued</th>
                <th className="p-3 text-right">Leave taken (annual / personal)</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {run.lines.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0">
                  <td className="p-3 font-medium">{l.employeeName}</td>
                  <td className="p-3 text-muted-foreground">
                    {l.taxRuleSetLabel}
                    {l.superCadence === "PAYDAY" && l.superSafeByDate ? (
                      <span className="block text-xs">super received by fund by {l.superSafeByDate} (conservative)</span>
                    ) : l.superCadence === "QUARTERLY" ? (
                      <span className="block text-xs">legacy quarterly super</span>
                    ) : null}
                  </td>
                  <td className="p-3 text-right">{Number(l.hoursPaid).toFixed(2)}</td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.grossPay} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.paygWithholding} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={l.superGuarantee} currency="AUD" />
                  </td>
                  <td className="p-3 text-right font-medium">
                    <MoneyDisplay amount={l.netPay} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">{Number(l.annualLeaveAccrued).toFixed(4)}</td>
                  <td className="p-3 text-right">{Number(l.personalLeaveAccrued).toFixed(4)}</td>
                  <td className="p-3 text-right">
                    {Number(l.annualLeaveTaken).toFixed(2)} / {Number(l.personalLeaveTaken).toFixed(2)}
                  </td>
                  <td className="p-3 text-right">
                    {run.status === "POSTED" ? (
                      <Link href={`/${org.slug}/payroll/payslips/${l.id}`} className="text-xs underline">
                        Payslip
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-medium">
                <td className="p-3" colSpan={3}>
                  Totals
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.grossPay} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.paygWithholding} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.superGuarantee} currency="AUD" />
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={run.totals.netPay} currency="AUD" />
                </td>
                <td className="p-3" colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {run.status === "POSTED" || run.status === "REVERSED" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Net wages payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Recording a payment posts Dr Net Wages Payable / Cr bank. Money Matters does not move any money: pay your
              staff at your bank (an ABA file can be generated below), then record it here.
            </p>
            {position ? (
              <p>
                Net wages {position.net} · paid {position.paid} · outstanding <strong>{position.outstanding}</strong>
              </p>
            ) : null}
            {payments.length > 0 ? (
              <ul className="space-y-1">
                {payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      {p.paymentDate.toISOString().slice(0, 10)} · {p.amount} · {p.status}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </span>
                    {p.status === "POSTED" ? (
                      <Can role={actor.role} permission="payroll_payment:manage">
                        <form action={reversePayrollPaymentAction.bind(null, org.slug, p.id, `pay-runs/${run.id}`)} className="flex items-center gap-1">
                          <Input name="reason" placeholder="Reason (10+ characters)" className="h-7 w-52" />
                          <Button type="submit" size="sm" variant="outline">
                            Reverse payment
                          </Button>
                        </form>
                      </Can>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {run.status === "POSTED" && position && Number(position.outstanding) > 0 ? (
              <Can role={actor.role} permission="payroll_payment:manage">
                <form action={boundPay} className="grid grid-cols-3 gap-3 border-t border-border pt-3">
                  <div className="space-y-1">
                    <Label htmlFor="bankAccountId">Paid from (bank account)</Label>
                    <select id="bankAccountId" name="bankAccountId" required className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                      {bankAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} · {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="paymentDate">Payment date</Label>
                    <Input id="paymentDate" name="paymentDate" type="date" required defaultValue={run.payDate} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="reference">Reference</Label>
                    <Input id="reference" name="reference" />
                  </div>
                  <div className="col-span-3">
                    <Button type="submit" size="sm">
                      Record net wages as paid
                    </Button>
                  </div>
                </form>
              </Can>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {run.status === "POSTED" && roleHasPermission(actor.role, "payroll_payment:manage") && roleHasPermission(actor.role, "employee:manage") ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bank file (ABA / Direct Entry)</CardTitle>
          </CardHeader>
          <CardContent>
            <form method="post" action={`/${org.slug}/payroll/pay-runs/${run.id}/aba`} className="grid grid-cols-2 gap-3 text-sm">
              <p className="col-span-2 text-xs text-muted-foreground">
                Generates a file in the Australian Direct Entry (ABA) layout for you to upload to your own bank. Nothing is
                sent anywhere and the bank identifiers below are not stored. Amounts are rounded to whole cents per employee.
                Whether your bank also wants a balancing debit record was not verified; none is added.
              </p>
              <div className="space-y-1">
                <Label htmlFor="fi">Bank abbreviation (3 letters)</Label>
                <Input id="fi" name="financialInstitution" maxLength={3} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="userId">APCA user id (up to 6 digits)</Label>
                <Input id="userId" name="userId" inputMode="numeric" maxLength={6} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="userName">User name (as registered, max 26)</Label>
                <Input id="userName" name="userName" maxLength={26} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="remitterName">Remitter name (max 16)</Label>
                <Input id="remitterName" name="remitterName" maxLength={16} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="traceBsb">Your BSB (nnn-nnn)</Label>
                <Input id="traceBsb" name="traceBsb" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="traceAccount">Your account number</Label>
                <Input id="traceAccount" name="traceAccount" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="processingDate">Processing date</Label>
                <Input id="processingDate" name="processingDate" type="date" required defaultValue={run.payDate} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="abaReference">Lodgement reference (max 18)</Label>
                <Input id="abaReference" name="reference" maxLength={18} />
              </div>
              <div className="col-span-2">
                <Button type="submit" size="sm" variant="outline">
                  Download ABA file
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {run.status === "POSTED" ? (
        <Can role={actor.role} permission="payrun:reverse">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Reverse this pay run</CardTitle>
            </CardHeader>
            <form action={boundReverse}>
              <CardContent className="space-y-2 text-sm">
                <p className="text-xs text-muted-foreground">
                  Posts a reversing journal, marks the run REVERSED and unwinds leave balances. Refused while net wages
                  are recorded as paid. Then create a corrected run for the same period.
                </p>
                <Input name="reason" placeholder="Reason (at least 10 characters)" required />
                <Button type="submit" size="sm" variant="outline">
                  Reverse pay run
                </Button>
              </CardContent>
            </form>
          </Card>
        </Can>
      ) : null}
    </div>
  );
}
