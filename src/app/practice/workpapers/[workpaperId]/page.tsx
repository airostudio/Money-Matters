import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCurrentPractice, errorParam } from "../../require-practice";
import { WorkpaperNotFoundError, WorkpaperService } from "@/domain/practice/workpaper-service";
import { WorkpaperCommentaryService } from "@/domain/practice/workpaper-commentary";
import { practiceRoleAtLeast } from "@/domain/practice/practice-access";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Notice } from "@/components/practice/light-badge";
import {
  addEvidenceAction,
  addNoteAction,
  adjustmentStatusAction,
  carryForwardAction,
  proposeAdjustmentAction,
  refreshSnapshotAction,
  removeEvidenceAction,
  reopenWorkpaperAction,
  resolveNoteAction,
  setScheduleAction,
  signPreparerAction,
  signReviewerAction,
} from "../../actions";

const BLANK_ROWS = 3;

export default async function WorkpaperPage({
  params,
  searchParams,
}: {
  params: { workpaperId: string };
  searchParams: { error?: string; notice?: string; summary?: string };
}) {
  const { user, actor, practice } = await requireCurrentPractice();
  const d = await WorkpaperService.get(actor, practice.id, params.workpaperId).catch((e) => {
    if (e instanceof WorkpaperNotFoundError) notFound();
    throw e;
  });
  const w = d.workpaper;
  const editable = w.status === "DRAFT";
  const open = w.status !== "SIGNED_OFF";
  const isManager = practiceRoleAtLeast(practice.role, "MANAGER");
  const isPreparer = w.preparedByUserId === user.id;
  const openNotes = d.notes.filter((n) => n.status === "OPEN");
  const error = errorParam(searchParams.error);
  const notice = typeof searchParams.notice === "string" ? searchParams.notice.slice(0, 600) : null;
  const rec = d.reconciliation;
  const summaryRequested = searchParams.summary === "1";
  const aiSummary = summaryRequested ? await WorkpaperCommentaryService.forWorkpaper(d) : null;
  const rows = [...d.lines, ...Array.from({ length: editable ? BLANK_ROWS : 0 }, (_, i) => ({ id: `blank-${i}`, lineNumber: 0, kind: "RECONCILING_ITEM" as const, description: "", reference: undefined, amount: "", isRecurring: false }))];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/practice/workpapers" className="hover:underline">
            Workpapers
          </Link>{" "}
          / {w.clientName}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {w.accountCode} {w.accountName} — as at {w.periodEnd}
        </h1>
        <p className="text-sm text-muted-foreground">
          {w.clientName} · {w.status.replace("_", " ").toLowerCase()} · version {w.version} · prepared by {w.preparedByName}
        </p>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {d.retentionNote && <Notice tone="warning">{d.retentionNote}</Notice>}
      {d.freshness.checked && d.freshness.stale && (
        <Notice tone="warning">
          The client&apos;s ledger has changed since this snapshot: the balance as at {w.periodEnd} is now {d.freshness.currentBalance} ({d.freshness.change} change). Refresh the snapshot to
          reconcile against the current figure{open ? "" : " — this workpaper is signed off, so reopen it first"}.
        </Notice>
      )}
      {!d.freshness.checked && !d.retentionNote && d.freshness.reason && <Notice>Live balance check unavailable: {d.freshness.reason}</Notice>}
      {d.freshness.checked && !d.freshness.stale && <Notice>The ledger balance still agrees with this snapshot (checked just now).</Notice>}

      {summaryRequested ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AI summary (optional)</CardTitle>
            <CardDescription>A reading aid written from the figures on this page only. It computes nothing, is not evidence, and cannot sign off, post or change anything.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">{aiSummary ?? <span className="text-muted-foreground">Not available (no AI key is configured, or the request failed). The figures below are unaffected.</span>}</CardContent>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">
          <Link href={`/practice/workpapers/${w.id}?summary=1`} className="text-primary hover:underline">
            Summarise this workpaper with AI
          </Link>{" "}
          (optional; only when an AI key is configured)
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Reconciliation</CardTitle>
            <CardDescription>{d.provenance}</CardDescription>
          </div>
          {editable && w.linkStatus === "ACTIVE" && (
            <form action={refreshSnapshotAction.bind(null, w.id)}>
              <Button type="submit" size="sm" variant="outline">
                Refresh snapshot
              </Button>
            </form>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Ledger balance ({w.currency})</dt>
              <dd className="text-lg font-semibold tabular-nums">{rec.ledgerBalance}</dd>
              <dd className="text-xs text-muted-foreground">per ledger as at {w.periodEnd}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Supporting schedule total</dt>
              <dd className="text-lg font-semibold tabular-nums">{rec.scheduleTotal}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Difference (ledger − schedule)</dt>
              <dd className={`text-lg font-semibold tabular-nums ${rec.isReconciled ? "text-success" : "text-destructive"}`}>
                {rec.difference} {rec.isReconciled ? "· reconciled" : "· unreconciled"}
              </dd>
            </div>
          </dl>
          {w.priorPeriodEnd && w.priorLedgerBalance && (
            <p className="text-sm text-muted-foreground">
              Comparative: {w.priorLedgerBalance} at {w.priorPeriodEnd} (carried forward from the previous workpaper; not recomputed).
            </p>
          )}

          <form action={setScheduleAction.bind(null, w.id)} className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2">Type</th>
                    <th className="py-1 pr-2">Description</th>
                    <th className="py-1 pr-2">Reference</th>
                    <th className="py-1 pr-2 text-right">Amount</th>
                    <th className="py-1">Recurring</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l, i) => (
                    <tr key={l.id}>
                      <td className="py-1 pr-2">
                        {editable ? (
                          <select name={`kind_${i}`} defaultValue={l.kind} aria-label="Line type" className="h-8 rounded-md border border-input bg-background px-1 text-xs">
                            <option value="SUPPORTING_BALANCE">Supporting balance</option>
                            <option value="RECONCILING_ITEM">Reconciling item</option>
                          </select>
                        ) : (
                          <span className="text-xs">{l.kind === "SUPPORTING_BALANCE" ? "Supporting balance" : "Reconciling item"}</span>
                        )}
                      </td>
                      <td className="py-1 pr-2">
                        {editable ? <Input name={`description_${i}`} defaultValue={l.description} aria-label="Description" placeholder="e.g. Bank statement balance" /> : l.description}
                      </td>
                      <td className="py-1 pr-2">{editable ? <Input name={`reference_${i}`} defaultValue={l.reference ?? ""} aria-label="Reference" /> : (l.reference ?? "")}</td>
                      <td className="py-1 pr-2 text-right">
                        {editable ? <Input name={`amount_${i}`} defaultValue={l.amount} aria-label="Amount" inputMode="decimal" className="text-right" /> : <span className="tabular-nums">{l.amount}</span>}
                      </td>
                      <td className="py-1">{editable ? <input type="checkbox" name={`recurring_${i}`} defaultChecked={l.isRecurring} aria-label="Recurring" /> : l.isRecurring ? "yes" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {editable && (
              <>
                <p className="text-xs text-muted-foreground">
                  Amounts are signed: a reconciling item that reduces the supporting balance (an outstanding cheque) is negative. Schedule total = every line added up; difference = ledger − total.
                  Recurring lines are copied into next period&apos;s workpaper.
                </p>
                <Button type="submit" size="sm">
                  Save schedule
                </Button>
              </>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evidence</CardTitle>
          <CardDescription>Held by your practice (not in the client&apos;s files). PDF or image, up to 10 MB each.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {d.evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">No evidence attached.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {d.evidence.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    <a className="text-primary hover:underline" href={`/practice/workpapers/${w.id}/evidence/${e.id}`}>
                      {e.fileName}
                    </a>{" "}
                    <span className="text-xs text-muted-foreground">
                      ({Math.ceil(e.fileSize / 1024)} KB · {e.uploadedByName}
                      {e.description ? ` · ${e.description}` : ""})
                    </span>
                  </span>
                  {open && (
                    <form action={removeEvidenceAction.bind(null, w.id, e.id)}>
                      <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                        Remove
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {open && (
            <form action={addEvidenceAction.bind(null, w.id)} className="flex flex-wrap items-end gap-2">
              <input type="file" name="file" required accept="application/pdf,image/*" aria-label="Evidence file" className="text-xs" />
              <Input name="description" placeholder="Description (optional)" aria-label="Evidence description" className="max-w-xs" />
              <Button type="submit" size="sm">
                Attach
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Proposed adjustments</CardTitle>
          <CardDescription>
            Recorded here as notes only. <strong>This system never posts them to the client&apos;s ledger</strong> — post an agreed adjustment through the client&apos;s normal journal
            screen, then mark it posted here with its journal reference (not verified).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {d.adjustments.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {d.adjustments.map((a) => (
                <li key={a.id} className="space-y-1 py-2">
                  <p>
                    <span className="font-medium">{a.description}</span> — {a.amount}
                    {a.debitAccount || a.creditAccount ? <span className="text-muted-foreground"> (Dr {a.debitAccount ?? "?"} / Cr {a.creditAccount ?? "?"})</span> : null}{" "}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      {a.status === "POSTED" ? `marked posted${a.postedReference ? ` · ${a.postedReference}` : ""}` : a.status.toLowerCase()}
                    </span>
                  </p>
                  {open && a.status === "PROPOSED" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={adjustmentStatusAction.bind(null, w.id, a.id, "POSTED")} className="flex items-center gap-1">
                        <Input name="postedReference" placeholder="Journal reference" aria-label="Journal reference" className="h-8 w-40" />
                        <Button type="submit" size="sm" variant="outline">
                          Mark posted by the client
                        </Button>
                      </form>
                      <form action={adjustmentStatusAction.bind(null, w.id, a.id, "DISMISSED")}>
                        <Button type="submit" size="sm" variant="ghost">
                          Dismiss
                        </Button>
                      </form>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {open && (
            <form action={proposeAdjustmentAction.bind(null, w.id)} className="grid gap-2 sm:grid-cols-4">
              <Input name="description" required placeholder="Description" aria-label="Adjustment description" className="sm:col-span-2" />
              <Input name="amount" required placeholder="Amount" aria-label="Adjustment amount" inputMode="decimal" />
              <Button type="submit" size="sm">
                Record proposal
              </Button>
              <Input name="debitAccount" placeholder="Debit account (text)" aria-label="Debit account" className="sm:col-span-2" />
              <Input name="creditAccount" placeholder="Credit account (text)" aria-label="Credit account" className="sm:col-span-2" />
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review notes</CardTitle>
          <CardDescription>Notes can be resolved but never deleted or rewritten; every open note must be resolved before the reviewer signs off.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {d.notes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No notes.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {d.notes.map((n) => (
                <li key={n.id} className="space-y-1 py-2">
                  <p className="text-xs text-muted-foreground">
                    {n.authorName} · v{n.version} · {n.createdAt.slice(0, 16).replace("T", " ")} · {n.status === "OPEN" ? "open" : `resolved by ${n.resolvedByName}`}
                  </p>
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  {n.resolutionComment && <p className="text-xs text-muted-foreground">Resolution: {n.resolutionComment}</p>}
                  {open && n.status === "OPEN" && (
                    <form action={resolveNoteAction.bind(null, w.id, n.id)} className="flex items-center gap-1">
                      <Input name="comment" placeholder="Resolution comment (optional)" aria-label="Resolution comment" className="h-8 max-w-xs" />
                      <Button type="submit" size="sm" variant="outline">
                        Resolve
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {open && (
            <form action={addNoteAction.bind(null, w.id)} className="space-y-2">
              <Label htmlFor="note-body">Add a review note</Label>
              <Textarea id="note-body" name="body" rows={2} required maxLength={2000} />
              <Button type="submit" size="sm">
                Add note
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sign-off</CardTitle>
          <CardDescription>
            The preparer signs first, then a different member of the practice reviews and signs. (A one-person practice may sign both steps; it is recorded as an exception.) Once signed off the workpaper is
            locked — a correction is a reopen with a reason, which starts a new version.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {w.status === "DRAFT" && (
            <form action={signPreparerAction.bind(null, w.id)} className="space-y-2">
              {!isPreparer && <p className="text-muted-foreground">Only {w.preparedByName}, who prepared it, can sign as preparer.</p>}
              {!rec.isReconciled && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="acknowledge" /> I acknowledge the unresolved difference of {rec.difference}.
                </label>
              )}
              <Button type="submit" disabled={!isPreparer}>
                Sign as preparer
              </Button>
            </form>
          )}
          {w.status === "IN_REVIEW" && (
            <div className="space-y-2">
              {isPreparer && <p className="text-muted-foreground">You prepared this; a different member must review it (unless the practice has a single staff member).</p>}
              {openNotes.length > 0 && <p className="text-warning">{openNotes.length} open review note{openNotes.length === 1 ? "" : "s"} must be resolved first.</p>}
              <form action={signReviewerAction.bind(null, w.id)} className="space-y-2">
                {!rec.isReconciled && (
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="acknowledge" /> I acknowledge the unresolved difference of {rec.difference}.
                  </label>
                )}
                <Button type="submit">Sign off as reviewer</Button>
              </form>
            </div>
          )}
          {(w.status === "IN_REVIEW" || (w.status === "SIGNED_OFF" && isManager)) && (
            <form action={reopenWorkpaperAction.bind(null, w.id)} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
              <div className="space-y-1">
                <Label htmlFor="reopen-reason">{w.status === "SIGNED_OFF" ? "Reopen for correction (reason required)" : "Return to draft (reason required)"}</Label>
                <Input id="reopen-reason" name="reason" required minLength={5} className="w-80" />
              </div>
              <Button type="submit" size="sm" variant="outline">
                {w.status === "SIGNED_OFF" ? "Reopen" : "Return to draft"}
              </Button>
            </form>
          )}
          {w.status === "SIGNED_OFF" && !isManager && <p className="text-muted-foreground">A manager or partner can reopen a signed-off workpaper.</p>}
          {w.status === "SIGNED_OFF" && w.linkStatus === "ACTIVE" && (
            <form action={carryForwardAction.bind(null, w.id)} className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
              <div className="space-y-1">
                <Label htmlFor="cf-period">Carry forward to the period ending</Label>
                <Input id="cf-period" name="periodEnd" type="date" />
              </div>
              <Button type="submit" size="sm">
                Carry forward
              </Button>
              <p className="basis-full text-xs text-muted-foreground">
                Copies the schedule structure (supporting balances reset to 0.00) and recurring items, shows this balance as the comparative and pulls a fresh balance. Evidence, notes, adjustments and sign-offs are never copied.
                Leave the date blank for the end of next month.
              </p>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 text-sm md:grid-cols-2">
          <div>
            <h3 className="mb-1 font-medium">Sign-offs and reopenings</h3>
            {d.signoffs.length === 0 ? (
              <p className="text-muted-foreground">None yet.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {d.signoffs.map((s) => (
                  <li key={s.id}>
                    v{s.version} · {s.step.toLowerCase()} · {s.userName} ({s.practiceRole.toLowerCase()}) · {s.createdAt.slice(0, 16).replace("T", " ")}
                    {s.singleStaffException ? " · single-staff exception" : ""}
                    {s.reason ? ` · “${s.reason}”` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-1 font-medium">Balance snapshots</h3>
            <ul className="space-y-1 text-xs">
              {d.snapshots.map((s) => (
                <li key={s.id} className="tabular-nums">
                  {s.ledgerBalance} as at {s.periodEnd}, pulled {s.takenAt.slice(0, 16).replace("T", " ")} by {s.takenByName} (as {s.takenByRole.toLowerCase().replace("_", " ")})
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
