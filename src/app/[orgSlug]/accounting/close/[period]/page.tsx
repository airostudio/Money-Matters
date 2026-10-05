import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAndActor } from "@/lib/session";
import { PeriodCloseService, type PeriodWorkspace } from "@/domain/close/period-close-service";
import { CloseCommentaryService } from "@/domain/close/commentary";
import { InvalidPeriodRefError } from "@/domain/close/period-ref";
import { FiscalPeriodNotFoundError } from "@/domain/ledger/errors";
import {
  CLOSE_LOCK_LEVELS,
  LOCK_DESCRIPTIONS,
  LOCK_LABELS,
  LOCK_RANK,
  MIN_REASON_LENGTH,
  TAX_REOPEN_ACK_PHRASE,
  isLocked,
  whoCanReopen,
  type LockLevel,
} from "@/domain/ledger/period-lock";
import { roleHasPermission } from "@/domain/permissions/roles";
import { CATEGORY_LABELS, CATEGORY_ORDER, type ChecklistItem } from "@/domain/close/checklist-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/accounting/status-badge";
import { cn } from "@/lib/utils";
import { closePeriodAction, raiseLockAction, reopenPeriodAction, revokeSignOffAction, signOffAction } from "../actions";

function fmt(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString("en-AU", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const SELECT = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
const TEXTAREA = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function StatusPill({ item }: { item: ChecklistItem }) {
  const base = "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium";
  if (item.status === "PASSED" && item.kind === "AUTOMATIC") {
    return <span className={cn(base, "bg-success/10 text-success")}>Verified by system</span>;
  }
  if (item.status === "PASSED") {
    return <span className={cn(base, "border border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300")}>Signed off by a person</span>;
  }
  if (item.status === "ATTENTION") return <span className={cn(base, "bg-warning/10 text-warning")}>Needs attention</span>;
  if (item.status === "BLOCKING") return <span className={cn(base, "bg-destructive/10 text-destructive")}>Blocking</span>;
  if (item.status === "MANUAL") return <span className={cn(base, "border border-dashed border-border bg-muted text-muted-foreground")}>Manual — needs sign-off</span>;
  return <span className={cn(base, "bg-muted text-muted-foreground")}>Not applicable</span>;
}

function ItemRow({
  item,
  orgSlug,
  periodKey,
  canSignOff,
  locked,
}: {
  item: ChecklistItem;
  orgSlug: string;
  periodKey: string;
  canSignOff: boolean;
  locked: boolean;
}) {
  const sign = signOffAction.bind(null, orgSlug, periodKey);
  const revoke = revokeSignOffAction.bind(null, orgSlug, periodKey);
  const canActOnManual = item.kind === "MANUAL" && item.status !== "NOT_APPLICABLE" && canSignOff && !locked;
  return (
    <li className="space-y-2 px-6 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{item.title}</p>
          <p className="text-sm text-muted-foreground">{item.detail}</p>
          {item.signoff && (
            <p className="mt-1 text-xs text-muted-foreground">
              Signed off by <strong>{item.signoff.signedByName ?? "a user"}</strong> on {fmt(item.signoff.signedAt)}
              {item.signoff.note ? <> — &ldquo;{item.signoff.note}&rdquo;</> : null}. This is a person&apos;s attestation,
              not a system check.
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <StatusPill item={item} />
          {item.href && (
            <Link href={`/${orgSlug}${item.href}`} className="text-sm text-primary hover:underline">
              {item.kind === "MANUAL" ? "Review →" : item.status === "PASSED" ? "View →" : "Fix →"}
            </Link>
          )}
        </div>
      </div>
      {canActOnManual && item.status === "MANUAL" && (
        <form action={sign} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="checkKey" value={item.id} />
          <Input name="note" placeholder="Optional note" className="h-8 max-w-xs text-xs" />
          <Button type="submit" size="sm" variant="outline">
            Sign off
          </Button>
        </form>
      )}
      {canActOnManual && item.status === "PASSED" && (
        <form action={revoke}>
          <input type="hidden" name="checkKey" value={item.id} />
          <Button type="submit" size="sm" variant="ghost">
            Revoke sign-off
          </Button>
        </form>
      )}
    </li>
  );
}

function ClosePanel({ w, orgSlug, periodKey }: { w: PeriodWorkspace; orgSlug: string; periodKey: string }) {
  const c = w.checklist;
  const close = closePeriodAction.bind(null, orgSlug, periodKey);
  const blocked = c.blocking.length > 0 || c.hiddenCount > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Close this period</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {c.blocking.length > 0 && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">Blocking items must be resolved first:</p>
            <ul className="mt-1 list-disc pl-5">
              {c.blocking.map((i) => (
                <li key={i.id}>
                  {i.title} — {i.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
        {c.hiddenCount > 0 && (
          <p className="rounded-md bg-warning/10 p-3 text-sm text-warning">
            {c.hiddenCount} checklist item group(s) are not visible to your role, so you cannot close this period.
          </p>
        )}
        <form action={close} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lockLevel">Lock level to apply</Label>
            <select id="lockLevel" name="lockLevel" defaultValue="SOFT_LOCKED" className={SELECT}>
              {CLOSE_LOCK_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LOCK_LABELS[l]}
                  {l === "SOFT_LOCKED" ? " (default)" : ""}
                </option>
              ))}
            </select>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {CLOSE_LOCK_LEVELS.map((l) => (
                <li key={l}>
                  <strong>{LOCK_LABELS[l]}:</strong> {LOCK_DESCRIPTIONS[l]}
                </li>
              ))}
            </ul>
          </div>
          {c.outstanding.length > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="acknowledgeOutstanding" required className="mt-1" />
              <span>
                I acknowledge {c.outstanding.length} outstanding item{c.outstanding.length === 1 ? "" : "s"} (needs
                attention or not yet signed off) and want to close this period anyway. This acknowledgement is recorded
                with the checklist snapshot.
              </span>
            </label>
          )}
          <div className="space-y-2">
            <Label htmlFor="note">Note (optional)</Label>
            <Input id="note" name="note" placeholder="e.g. September close, accruals pending" />
          </div>
          <Button type="submit" disabled={blocked}>
            Close period
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function LockedPanel({
  w,
  orgSlug,
  periodKey,
  canClose,
  canReopen,
  canReopenHard,
}: {
  w: PeriodWorkspace;
  orgSlug: string;
  periodKey: string;
  canClose: boolean;
  canReopen: boolean;
  canReopenHard: boolean;
}) {
  const level = w.checklist.period.lockLevel;
  const raise = raiseLockAction.bind(null, orgSlug, periodKey);
  const reopen = reopenPeriodAction.bind(null, orgSlug, periodKey);
  const mayReopenThis = LOCK_RANK[level] >= LOCK_RANK.TAX_LOCKED ? canReopenHard : canReopen;
  const higher = CLOSE_LOCK_LEVELS.filter((l) => LOCK_RANK[l] > LOCK_RANK[level]);
  const lower = (["OPEN", ...CLOSE_LOCK_LEVELS] as LockLevel[]).filter((l) => LOCK_RANK[l] < LOCK_RANK[level]);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {canClose && higher.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Raise the lock</CardTitle>
          </CardHeader>
          <form action={raise}>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Tighten this period, e.g. to Tax lock once the return is lodged. Posting is restricted further; nothing
                already posted changes.
              </p>
              <select name="lockLevel" className={SELECT} defaultValue={higher[0]}>
                {higher.map((l) => (
                  <option key={l} value={l}>
                    {LOCK_LABELS[l]}
                  </option>
                ))}
              </select>
              <Input name="reason" placeholder="Reason / label, e.g. BAS lodged 28 Oct (optional)" />
              <Button type="submit" variant="outline" size="sm">
                Raise lock
              </Button>
            </CardContent>
          </form>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reopen this period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Reopening lowers the lock so entries can be posted again. It never alters posted entries. A reason is
            mandatory and is recorded — who, when, why, before and after — in the period&apos;s append-only lock history
            and the audit log. {whoCanReopen(level)}.
          </p>
          {mayReopenThis ? (
            <form action={reopen} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="reopen-reason">Reason (at least {MIN_REASON_LENGTH} characters)</Label>
                <textarea
                  id="reopen-reason"
                  name="reason"
                  required
                  minLength={MIN_REASON_LENGTH}
                  rows={2}
                  className={TEXTAREA}
                  placeholder="e.g. Supplier credit note received after close"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="toLevel">Lower to</Label>
                <select id="toLevel" name="toLevel" className={SELECT} defaultValue="OPEN">
                  {lower.map((l) => (
                    <option key={l} value={l}>
                      {LOCK_LABELS[l]}
                    </option>
                  ))}
                </select>
              </div>
              {level === "TAX_LOCKED" && (
                <div className="space-y-2">
                  <Label htmlFor="acknowledgement">
                    Acknowledgement — type that reopening {TAX_REOPEN_ACK_PHRASE}
                  </Label>
                  <Input
                    id="acknowledgement"
                    name="acknowledgement"
                    required
                    placeholder={`I understand this ${TAX_REOPEN_ACK_PHRASE}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    This period is covered by a lodged return/BAS. Changes after lodgement can invalidate it.
                  </p>
                </div>
              )}
              <Button type="submit" variant="destructive" size="sm">
                Reopen period
              </Button>
            </form>
          ) : (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              Your role cannot reopen a {LOCK_LABELS[level].toLowerCase()}ed period. {whoCanReopen(level)} — ask them to do it (with a reason).
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default async function CloseWorkspacePage({
  params,
  searchParams,
}: {
  params: { orgSlug: string; period: string };
  searchParams: { error?: string; notice?: string; summary?: string };
}) {
  const { actor, org } = await requireOrgAndActor(params.orgSlug);
  let w: PeriodWorkspace;
  try {
    w = await PeriodCloseService.getWorkspace(actor, params.period);
  } catch (error) {
    if (error instanceof InvalidPeriodRefError || error instanceof FiscalPeriodNotFoundError) notFound();
    throw error;
  }

  const c = w.checklist;
  const level = c.period.lockLevel;
  const locked = isLocked(level);
  const canClose = roleHasPermission(actor.role, "period:close");
  const canReopen = roleHasPermission(actor.role, "period:reopen");
  const canReopenHard = roleHasPermission(actor.role, "period:reopen_hard");
  const canSignOff = roleHasPermission(actor.role, "close_checklist:manage");
  const aiAvailable = Boolean(process.env.ANTHROPIC_API_KEY);
  const summary = searchParams.summary === "1" && aiAvailable ? await CloseCommentaryService.forChecklist(c) : null;

  const byCategory = CATEGORY_ORDER.map((cat) => ({ cat, items: c.items.filter((i) => i.category === cat) })).filter((g) => g.items.length > 0);
  const manualPending = c.items.filter((i) => i.status === "MANUAL").length;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href={`/${org.slug}/accounting/close`} className="text-sm text-muted-foreground hover:underline">
          ← Month-End Close
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{c.period.label}</h1>
          <StatusBadge status={level} />
          {w.cycles[0] && <StatusBadge status={w.cycles[0].status} />}
        </div>
        <p className="text-sm text-muted-foreground">
          {day(c.period.start)} – {day(c.period.end)}. {LOCK_DESCRIPTIONS[level]}
        </p>
      </div>

      {searchParams.error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{searchParams.error}</p>}
      {searchParams.notice && <p className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">{searchParams.notice}</p>}

      {w.coveredBy.length > 0 && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
          This period also falls within a locked period:{" "}
          {w.coveredBy.map((p, i) => (
            <span key={p.key}>
              {i > 0 && ", "}
              <Link href={`/${org.slug}/accounting/close/${p.key}`} className="underline">
                {p.label}
              </Link>{" "}
              ({LOCK_LABELS[p.level]})
            </span>
          ))}
          . The most restrictive lock governs posting; reopen that period to change it.
        </p>
      )}

      <Card>
        <CardContent className="space-y-3 p-6">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Month Close</p>
              <p className="text-4xl font-semibold tracking-tight">{c.progress.percent}% complete</p>
            </div>
            <p className="text-right text-sm text-muted-foreground">
              {c.progress.complete} of {c.progress.applicable} applicable items passed
            </p>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={c.progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Month close progress"
          >
            <div className="h-full bg-primary transition-all" style={{ width: `${c.progress.percent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">{c.progress.formula}</p>
          {c.hiddenCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {c.hiddenCount} item group(s) are not visible to your role (e.g. payroll) and are not counted.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">What remains ({c.remaining.length})</CardTitle>
          {aiAvailable && !summary && (
            <Link href={`?summary=1`} className="text-xs text-primary hover:underline">
              Summarise in plain language (AI)
            </Link>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {summary && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <p>{summary}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                AI summary of the checklist above — it only restates what was computed, can&apos;t change anything, and
                is never a source of figures.
              </p>
            </div>
          )}
          {c.remaining.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing remains: every applicable item has passed.</p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {c.remaining.map((i) => (
                <li key={i.id}>
                  <span className="font-medium">{i.title}</span>
                  {i.status === "MANUAL" ? " — awaiting a person's sign-off" : ` — ${i.detail}`}
                  {i.href && (
                    <>
                      {" "}
                      <Link href={`/${org.slug}${i.href}`} className="text-primary hover:underline">
                        →
                      </Link>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {byCategory.map(({ cat, items }) => (
        <Card key={cat}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{CATEGORY_LABELS[cat]}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {items.map((i) => (
                <ItemRow key={i.id} item={i} orgSlug={org.slug} periodKey={c.period.key} canSignOff={canSignOff} locked={locked} />
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
      {manualPending > 0 && !locked && canSignOff && (
        <p className="text-xs text-muted-foreground">
          Manual items are things the system cannot verify. Signing one off records your name and the time; it is shown
          as a person&apos;s sign-off, never as system verification.
        </p>
      )}

      {!locked && canClose && <ClosePanel w={w} orgSlug={org.slug} periodKey={c.period.key} />}
      {!locked && !canClose && (
        <p className="text-sm text-muted-foreground">Your role can review this checklist but cannot close the period (an Accountant, Administrator or Owner can).</p>
      )}
      {locked && (
        <LockedPanel
          w={w}
          orgSlug={org.slug}
          periodKey={c.period.key}
          canClose={canClose}
          canReopen={canReopen}
          canReopenHard={canReopenHard}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Close history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {w.cycles.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">This period has not been worked on yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-6 py-2">Cycle</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Started</th>
                  <th className="px-3 py-2">Closed</th>
                  <th className="px-3 py-2">Lock applied</th>
                  <th className="px-3 py-2">% at close</th>
                  <th className="px-3 py-2">Acknowledged</th>
                </tr>
              </thead>
              <tbody>
                {w.cycles.map((cy) => (
                  <tr key={cy.id} className="border-b border-border last:border-0">
                    <td className="px-6 py-2">#{cy.cycle}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={cy.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt(cy.startedAt)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmt(cy.closedAt)}
                      {cy.closedByName ? ` · ${cy.closedByName}` : ""}
                    </td>
                    <td className="px-3 py-2">{cy.lockLevelApplied ? <StatusBadge status={cy.lockLevelApplied} /> : "—"}</td>
                    <td className="px-3 py-2">{cy.percentAtClose !== null ? `${cy.percentAtClose}%` : "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{cy.status === "CLOSED" ? `${cy.acknowledgedAttentionCount} item(s)` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lock history</CardTitle>
        </CardHeader>
        <CardContent>
          {w.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No lock changes yet.</p>
          ) : (
            <ol className="space-y-4 border-l border-border pl-4">
              {w.events.map((e) => (
                <li key={e.id} className="relative text-sm">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden />
                  <p>
                    <span className="font-medium">
                      {e.eventType === "POSTING_OVERRIDE"
                        ? "Posted under override"
                        : e.eventType === "REOPENED"
                          ? "Reopened"
                          : e.eventType === "LEVEL_LOWERED"
                            ? "Lock lowered"
                            : e.eventType === "MIGRATED"
                              ? "Carried over from the previous lock model"
                              : "Locked"}
                    </span>{" "}
                    {e.eventType !== "POSTING_OVERRIDE" && (
                      <span className="text-muted-foreground">
                        {LOCK_LABELS[e.fromLevel]} → {LOCK_LABELS[e.toLevel]}
                      </span>
                    )}
                    {e.journalEntryId && (
                      <>
                        {" "}
                        <Link href={`/${org.slug}/accounting/journals/${e.journalEntryId}`} className="text-primary hover:underline">
                          view entry
                        </Link>
                      </>
                    )}
                  </p>
                  <p className="text-muted-foreground">&ldquo;{e.reason}&rdquo;</p>
                  {e.acknowledgement && <p className="text-xs text-muted-foreground">Acknowledged: &ldquo;{e.acknowledgement}&rdquo;</p>}
                  <p className="text-xs text-muted-foreground">
                    {fmt(e.createdAt)} · {e.actorName ?? "System"}
                    {e.actorRole ? ` (${e.actorRole.toLowerCase().replace("_", " ")})` : ""}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
