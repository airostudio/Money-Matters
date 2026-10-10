import { roleHasPermission } from "@/domain/permissions/roles";
import { loadClientAccessMap } from "./client-access";
import { HealthService } from "./health-service";
import { PracticeService } from "./practice-service";
import { WorkpaperService, type WorkpaperDetail } from "./workpaper-service";
import type { PracticeActor } from "./types";

/**
 * What the read-only AI Financial Controller tools (`practice_overview`, `workpaper_status`) are allowed
 * to say about a practice — text assembled ONLY from already-computed values, through the same
 * services the practice UI uses, so the model can never see more than the person could:
 *
 *  - the practice is one the person is an ACTIVE member of (the database refuses any other);
 *  - a client appears only if the person holds a real membership in it, its link is ACTIVE, and the
 *    per-client permission the figure needs is held by THEIR role there — a client they cannot read,
 *    or whose consent has been revoked, is left out and counted ("N excluded"), never named;
 *  - the dashboard is read from saved snapshots (the assistant cannot refresh and so cannot fan out
 *    connections); a workpaper detail makes at most three sequential single-account checks.
 * There is no write path here: nothing in this module posts, refreshes, signs off or changes a link.
 */

const MAX_PAPERS_LISTED = 15;
const MAX_PAPERS_DETAILED = 3;

async function choosePractice(actor: PracticeActor, wanted?: string) {
  const mine = await PracticeService.listMine(actor);
  if (mine.length === 0) return { kind: "message", message: "This user is not a member of any accountant practice, so there is nothing to report." } as const;
  const name = wanted?.trim().toLowerCase();
  const matches = name ? mine.filter((p) => p.name.toLowerCase().includes(name)) : mine;
  if (matches.length !== 1) {
    return { kind: "message", message: `Which practice? This user belongs to: ${mine.map((p) => p.name).join(", ")}. Ask them to pick one.` } as const;
  }
  return { kind: "practice", practice: matches[0]! } as const;
}

export async function practiceOverviewFacts(
  userId: string,
  opts: { practice?: string; filter?: "ALL" | "NEEDS_INTERVENTION"; page?: number; now?: Date } = {},
): Promise<string> {
  const actor: PracticeActor = { userId, type: "AI" };
  const chosen = await choosePractice(actor, opts.practice);
  if (chosen.kind === "message") return chosen.message;
  const dash = await HealthService.dashboard(actor, chosen.practice.id, { page: opts.page, filter: opts.filter ?? "NEEDS_INTERVENTION", now: opts.now });

  const lines: string[] = [
    `Practice "${chosen.practice.name}" dashboard — SAVED SNAPSHOT figures (not live; you cannot refresh them). ${dash.totalMatching} client(s) match, page ${dash.page} of ${dash.totalPages}, worst first.`,
  ];
  if (dash.rows.length === 0) lines.push("No clients to list.");
  for (const r of dash.rows) {
    lines.push(
      `${r.clientName}: Books — ${r.indicators.books.label}; Reconciliation — ${r.indicators.reconciliation.label}; ` +
        `BAS/Tax — ${r.indicators.tax.label} (a deadline the practice entered by hand, not an official date); Payroll — ${r.indicators.payroll.label}; ` +
        `Issues ${r.indicators.issues}; assigned to ${r.assignedName ?? "nobody"}; snapshot ${r.snapshot ? `as of ${r.snapshot.age}${r.snapshot.stale ? " (stale)" : ""}` : "never refreshed"}.`,
    );
  }
  if (dash.notAccessibleCount > 0) {
    lines.push(`${dash.notAccessibleCount} linked client(s) are excluded — this user has no access to them. Do not guess at them.`);
  }
  if (dash.endedDuringLoad > 0) lines.push(`${dash.endedDuringLoad} client(s) ended the practice's access and were left out.`);
  lines.push("There is no BAS/GST preparation or lodgement in this system; never present a BAS figure.");
  return lines.join("\n");
}

export async function workpaperStatusFacts(
  userId: string,
  opts: { practice?: string; client?: string; status?: "DRAFT" | "IN_REVIEW" | "SIGNED_OFF" } = {},
): Promise<string> {
  const actor: PracticeActor = { userId, type: "AI" };
  const chosen = await choosePractice(actor, opts.practice);
  if (chosen.kind === "message") return chosen.message;

  const papers = await WorkpaperService.list(actor, chosen.practice.id, { status: opts.status });
  const access = await loadClientAccessMap(userId);
  const readable = papers.filter((p) => {
    const entry = access.get(p.clientOrganizationId);
    return (
      p.linkStatus === "ACTIVE" &&
      entry !== undefined &&
      roleHasPermission(entry.role, "financial_report:read") &&
      roleHasPermission(entry.role, "journal:read")
    );
  });
  const excluded = papers.length - readable.length;
  const wanted = opts.client?.trim().toLowerCase();
  const matching = wanted ? readable.filter((p) => p.clientName.toLowerCase().includes(wanted)) : readable;

  const lines: string[] = [`Practice "${chosen.practice.name}" workpapers (balance-sheet account reconciliations): ${matching.length} listed.`];
  for (const p of matching.slice(0, MAX_PAPERS_LISTED)) {
    lines.push(
      `${p.clientName} — ${p.accountCode} ${p.accountName} as at ${p.periodEnd}: ${p.status.replace("_", " ")} (version ${p.version}), ledger balance ${p.ledgerBalance} ` +
        `(a snapshot pulled ${p.snapshotTakenAt.slice(0, 10)}), ${p.openNotes} open review note(s), prepared by ${p.preparedByName}.`,
    );
  }
  if (matching.length > MAX_PAPERS_LISTED) lines.push(`...and ${matching.length - MAX_PAPERS_LISTED} more.`);

  // A little more detail (the reconciliation) for at most three — each a short, sequential, single-account read.
  for (const p of matching.slice(0, MAX_PAPERS_DETAILED)) {
    const d = await WorkpaperService.get(actor, chosen.practice.id, p.id);
    lines.push(...workpaperFacts(d).map((l) => `  [${p.clientName} ${p.accountCode}] ${l}`));
  }
  if (excluded > 0) lines.push(`${excluded} workpaper(s) are excluded — the user cannot currently read those clients. Do not guess at them.`);
  lines.push("A workpaper holds a point-in-time snapshot; adjustments are proposals only and are never posted by this system.");
  return lines.join("\n");
}

/** Plain facts about ONE workpaper — only values it already computed (shared by the tool and the optional commentary). */
export function workpaperFacts(d: Omit<WorkpaperDetail, "freshness"> & { freshness?: WorkpaperDetail["freshness"] }): string[] {
  const w = d.workpaper;
  const r = d.reconciliation;
  const facts = [
    `Status ${w.status.replace("_", " ")} (version ${w.version}); balance as at ${w.periodEnd}; ${d.provenance}`,
    `Ledger balance ${r.ledgerBalance} ${w.currency}; supporting schedule total ${r.scheduleTotal}; difference (ledger minus schedule) ${r.difference} — ${r.isReconciled ? "RECONCILED" : "NOT reconciled"}.`,
    `${d.lines.length} schedule line(s); ${d.evidence.length} evidence file(s); ${d.notes.filter((n) => n.status === "OPEN").length} open and ${d.notes.filter((n) => n.status === "RESOLVED").length} resolved review note(s).`,
  ];
  const proposed = d.adjustments.filter((a) => a.status === "PROPOSED");
  if (d.adjustments.length > 0) {
    facts.push(
      `${proposed.length} proposed adjustment(s) not yet posted${proposed.length ? `: ${proposed.map((a) => `${a.description} ${a.amount}`).join("; ")}` : ""}; ` +
        `${d.adjustments.filter((a) => a.status === "POSTED").length} marked posted by the client; proposals are notes only — this system never posts them.`,
    );
  }
  if (w.priorPeriodEnd && w.priorLedgerBalance) facts.push(`Comparative: ${w.priorLedgerBalance} at ${w.priorPeriodEnd}.`);
  if (d.freshness?.checked && d.freshness.stale) facts.push(`The ledger has changed since the snapshot (now ${d.freshness.currentBalance}, change ${d.freshness.change}).`);
  if (d.retentionNote) facts.push(d.retentionNote);
  const signed = d.signoffs.filter((s) => s.version === w.version && s.step !== "REOPEN");
  if (signed.length) facts.push(`Signed: ${signed.map((s) => `${s.step.toLowerCase()} by ${s.userName}${s.singleStaffException ? " (single-staff exception)" : ""}`).join("; ")}.`);
  return facts;
}
