import Link from "next/link";
import { Can } from "@/components/shell/can";
import { deniedViewUnless } from "@/lib/permission-gate";
import { requireOrgAndActor } from "@/lib/session";
import { BasService } from "@/domain/tax/bas-service";
import {
  BAS_LABELS,
  BAS_LABEL_SOURCES,
  BAS_LABEL_TITLES,
  drillDown,
  payrollDrillDown,
  type BasLabel,
} from "@/domain/tax/bas-calculations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyDisplay } from "@/components/accounting/money-display";
import { roleHasPermission } from "@/domain/permissions/roles";
import { deleteBasDraftAction, finaliseBasAction, markBasLodgedAction } from "../actions";

const DOC_PATH: Record<string, string> = {
  INVOICE: "sales/invoices",
  BILL: "purchases/bills",
  SUPPLIER_CREDIT: "purchases/supplier-credits",
  CUSTOMER_CREDIT: "sales/credit-notes",
  EXPENSE_CLAIM: "expenses",
};

export default async function BasDetailPage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; basId: string };
  searchParams: { error?: string; label?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  const denied = deniedViewUnless(actor, "bas:read", org.slug);
  if (denied) return denied;
  const view = await BasService.get(actor, params.basId);
  const { statement, report } = view;
  const base = `/${org.slug}/accounting/bas/${statement.id}`;
  const label = (BAS_LABELS as readonly string[]).includes(searchParams.label ?? "")
    ? (searchParams.label as BasLabel)
    : null;
  const drill = label && label !== "W1" && label !== "W2" ? drillDown(report.sources, label) : [];
  const payDrill = label === "W1" || label === "W2" ? payrollDrillDown(report.payroll, label) : [];
  const boundFinalise = finaliseBasAction.bind(null, org.slug, statement.id);
  const boundLodged = markBasLodgedAction.bind(null, org.slug, statement.id);
  const boundDelete = deleteBasDraftAction.bind(null, org.slug, statement.id);
  const finalised = statement.status === "FINALISED";
  const canSeeCsv = roleHasPermission(actor.role, "bas:read");

  return (
    <div className="max-w-5xl space-y-6">
      {searchParams.error ? (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{searchParams.error}</p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            BAS worksheet: {report.periodStart} to {report.periodEnd}
          </h1>
          <p className="text-sm text-muted-foreground">
            {statement.frequency} · {report.basis} basis · {report.baseCurrency}
            {statement.note ? ` · ${statement.note}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              finalised ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
            }`}
          >
            {statement.status}
          </span>
          {canSeeCsv ? (
            <Button asChild size="sm" variant="outline">
              <a href={`${base}/export`}>Export CSV</a>
            </Button>
          ) : null}
        </div>
      </div>

      <p className="rounded-md bg-amber-500/10 p-3 text-xs text-amber-700">
        {report.disclaimer} Requires registered tax agent / BAS agent review; NOT lodged with the ATO.
      </p>

      {finalised ? (
        <Card>
          <CardContent className="space-y-1 p-4 text-sm">
            <p>
              Finalised {statement.finalisedAt?.toISOString().slice(0, 16).replace("T", " ")} UTC. This is an immutable
              snapshot.
            </p>
            <p className="break-all font-mono text-xs text-muted-foreground">SHA-256: {statement.contentHash}</p>
            <p className="text-xs">
              Snapshot integrity check: {view.hashVerified ? "hash matches the stored figures" : "HASH MISMATCH - do not rely on this snapshot"}
            </p>
            {view.liveDrift && view.liveDrift.length > 0 ? (
              <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-700">
                The ledger has changed since finalising. Live values now differ at:{" "}
                {view.liveDrift.map((d) => `${d.label} (${d.snapshot} -> ${d.live})`).join(", ")}. The snapshot is unchanged.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">The live ledger still agrees with this snapshot.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {report.warnings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Warnings</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">BAS labels</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Label</th>
                <th className="p-3">Description</th>
                <th className="p-3 text-right">Amount</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {BAS_LABELS.map((l) => (
                <tr key={l} className="border-b border-border last:border-0">
                  <td className="p-3 font-mono">{l}</td>
                  <td className="p-3">{BAS_LABEL_TITLES[l]}</td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={report.figures.labels[l]} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <Link href={`${base}?label=${l}#drill`} className="text-xs underline">
                      Drill down
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-medium">
                <td className="p-3" colSpan={2}>
                  Net GST (1A minus 1B; positive = payable, negative = refundable)
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={report.figures.netGst} currency="AUD" />
                </td>
                <td />
              </tr>
              <tr className="text-muted-foreground">
                <td className="p-3" colSpan={2}>
                  Money Matters summary (not an ATO label): 1A minus 1B plus W2
                </td>
                <td className="p-3 text-right">
                  <MoneyDisplay amount={report.figures.netGstPlusPaygWithheld} currency="AUD" />
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      {label ? (
        <Card>
          <CardHeader>
            <CardTitle id="drill" className="text-base">
              Source transactions for {label} - {BAS_LABEL_TITLES[label]}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-3">Source</th>
                  <th className="p-3">Date</th>
                  <th className="p-3">Event</th>
                  <th className="p-3">Detail</th>
                  <th className="p-3 text-right">Contribution</th>
                </tr>
              </thead>
              <tbody>
                {drill.map(({ line, amount }) => (
                  <tr key={`${line.lineId}-${line.event}`} className="border-b border-border last:border-0">
                    <td className="p-3">
                      <Link href={`/${org.slug}/${DOC_PATH[line.docType]}/${line.docId}`} className="underline">
                        {line.docType.replace("_", " ")} {line.docNumber}
                      </Link>{" "}
                      <span className="text-xs text-muted-foreground">line {line.lineNumber}</span>
                    </td>
                    <td className="p-3">{line.postingDate}</td>
                    <td className="p-3">{line.event}</td>
                    <td className="p-3 text-muted-foreground">
                      {line.description} ({line.taxCodeCode})
                    </td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={amount} currency="AUD" />
                    </td>
                  </tr>
                ))}
                {payDrill.map(({ payroll, amount }) => (
                  <tr key={`${payroll.payRunId}-${payroll.event}`} className="border-b border-border last:border-0">
                    <td className="p-3">
                      <Link href={`/${org.slug}/payroll/pay-runs/${payroll.payRunId}`} className="underline">
                        Pay run {payroll.periodStart} to {payroll.periodEnd}
                      </Link>
                    </td>
                    <td className="p-3">{payroll.payDate}</td>
                    <td className="p-3">{payroll.event}</td>
                    <td className="p-3 text-muted-foreground">Posted pay run totals</td>
                    <td className="p-3 text-right">
                      <MoneyDisplay amount={amount} currency="AUD" />
                    </td>
                  </tr>
                ))}
                {drill.length === 0 && payDrill.length === 0 ? (
                  <tr>
                    <td className="p-3 text-muted-foreground" colSpan={5}>
                      Nothing contributes to this label in the period.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Disclosed but NOT included in any label</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>
            Input-taxed sales already inside G1 (net): <MoneyDisplay amount={report.figures.memo.inputTaxedSalesInG1} currency="AUD" />
          </p>
          <p>
            Purchases under GST-free / input-taxed / not-reported codes, excluded from G10 and G11 because their
            placement could not be verified (net): <MoneyDisplay amount={report.figures.memo.otherPurchasesExcluded} currency="AUD" />
          </p>
          <p>
            Sales under not-reported codes (net): <MoneyDisplay amount={report.figures.memo.notReportedSales} currency="AUD" />
          </p>
          <p>
            Unclassified sales lines: {report.figures.unclassified.sales.count} (net {report.figures.unclassified.sales.net}, GST{" "}
            {report.figures.unclassified.sales.gst}). Unclassified purchase lines: {report.figures.unclassified.purchases.count} (net{" "}
            {report.figures.unclassified.purchases.net}, GST {report.figures.unclassified.purchases.gst}).
          </p>
          <p>
            Tax-coded journal lines with no GST split: {report.adHocTaxCodedLines.count} (total {report.adHocTaxCodedLines.totalAmount}).
          </p>
          {report.adHocTaxCodedLines.shown.length > 0 ? (
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {report.adHocTaxCodedLines.shown.map((a) => (
                <li key={`${a.journalEntryId}-${a.accountCode}-${a.amount}`}>
                  <Link href={`/${org.slug}/accounting/journals/${a.journalEntryId}`} className="underline">
                    {a.entryNumber}
                  </Link>{" "}
                  {a.postingDate} · account {a.accountCode} · {a.taxCode} ({a.treatment ?? "unclassified"}) · {a.amount}
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reconciliation to GST control accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Account</th>
                <th className="p-3">Role</th>
                <th className="p-3 text-right">Debits</th>
                <th className="p-3 text-right">Credits</th>
                <th className="p-3 text-right">Movement</th>
              </tr>
            </thead>
            <tbody>
              {report.reconciliation.accounts.map((a) => (
                <tr key={a.accountId} className="border-b border-border last:border-0">
                  <td className="p-3">
                    {a.code} · {a.name}
                  </td>
                  <td className="p-3 text-muted-foreground">{a.role === "SALES_GST" ? "GST on sales" : "GST on purchases"}</td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={a.debit} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={a.credit} currency="AUD" />
                  </td>
                  <td className="p-3 text-right">
                    <MoneyDisplay amount={a.movement} currency="AUD" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-1 px-3 pb-3 text-sm">
            <p>
              Ledger net GST: <MoneyDisplay amount={report.reconciliation.ledgerNet} currency="AUD" /> · BAS net GST:{" "}
              <MoneyDisplay amount={report.reconciliation.basNet} currency="AUD" />
            </p>
            <p className="font-medium">
              Variance (ledger minus BAS, never plugged): <MoneyDisplay amount={report.reconciliation.variance} currency="AUD" />
            </p>
            {report.nonDocumentControlLines.length > 0 ? (
              <details className="text-xs text-muted-foreground">
                <summary>Control-account postings that are not invoices, bills, credits or claims (the usual cause of a variance)</summary>
                <ul className="list-disc pl-5">
                  {report.nonDocumentControlLines.map((l) => (
                    <li key={`${l.journalEntryId}-${l.accountCode}-${l.debit}-${l.credit}`}>
                      <Link href={`/${org.slug}/accounting/journals/${l.journalEntryId}`} className="underline">
                        {l.entryNumber}
                      </Link>{" "}
                      {l.postingDate} · {l.accountCode} · Dr {l.debit} Cr {l.credit} {l.memo ? `· ${l.memo}` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period lock</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {report.periodLock.months.map((m) => `${m.key}: ${m.level}`).join(" · ")}
          {finalised ? <p className="mt-1 text-xs text-muted-foreground">At finalise: {statement.periodLockAtFinalise}</p> : null}
        </CardContent>
      </Card>

      {!finalised ? (
        <div className="flex flex-wrap gap-4">
          <Can role={actor.role} permission="bas:finalise">
            <Card className="flex-1">
              <CardHeader>
                <CardTitle className="text-base">Finalise (human sign-off)</CardTitle>
              </CardHeader>
              <form action={boundFinalise}>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">
                    Snapshots these figures immutably with a content hash. Later ledger changes will not alter the snapshot.
                    This does NOT lodge anything with the ATO.
                  </p>
                  {report.warnings.length > 0 ? (
                    <label className="flex items-start gap-2">
                      <input type="checkbox" name="acknowledge" className="mt-1" />
                      <span>I have reviewed the {report.warnings.length} warning(s) above and accept finalising with them outstanding.</span>
                    </label>
                  ) : null}
                  <Button type="submit">Finalise BAS worksheet</Button>
                </CardContent>
              </form>
            </Card>
          </Can>
          <Can role={actor.role} permission="bas:manage">
            <form action={boundDelete}>
              <Button type="submit" variant="outline" size="sm">
                Discard draft
              </Button>
            </form>
          </Can>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lodged outside Money Matters</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Money Matters never lodges anything with the ATO. This is only a note that you or your agent lodged this BAS
              elsewhere; the reference is not verified.
            </p>
            {view.lodgements.length > 0 ? (
              <ul className="list-disc pl-5">
                {view.lodgements.map((l) => (
                  <li key={l.id}>
                    Lodged {l.lodgedOn.toISOString().slice(0, 10)} outside Money Matters - reference {l.reference} (recorded{" "}
                    {l.createdAt.toISOString().slice(0, 10)})
                  </li>
                ))}
              </ul>
            ) : (
              <p>No lodgement recorded.</p>
            )}
            <Can role={actor.role} permission="bas:finalise">
              <form action={boundLodged} className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="lodgedOn">Lodged on</Label>
                  <Input id="lodgedOn" name="lodgedOn" type="date" required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reference">Reference</Label>
                  <Input id="reference" name="reference" required />
                </div>
                <div className="col-span-2">
                  <Button type="submit" variant="outline" size="sm">
                    Record lodgement made outside Money Matters
                  </Button>
                </div>
              </form>
            </Can>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where the label definitions come from</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {Object.entries(BAS_LABEL_SOURCES).map(([k, v]) => (
              <li key={k}>
                <strong>{k}:</strong> {v}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
