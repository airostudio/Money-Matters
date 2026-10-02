import "server-only";
import { and, eq } from "drizzle-orm";
import { aiAutoExecutions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { RecurringInvoiceService } from "@/domain/sales/recurring-invoice-service";
import { RecurringBillService } from "@/domain/purchases/recurring-bill-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import { BillService } from "@/domain/purchases/bill-service";
import { ReconciliationService } from "@/domain/banking/reconciliation-service";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { AutonomySettingsService } from "./autonomy";
import { isAutoExecutionApproved, type AutoApprovedActionType } from "./auto-execution-policy";

/**
 * Phase 6 Slice 3's auto-execution engine. This is the ONLY code path that
 * ever turns `isAutoExecutionApproved`'s "yes" into something actually
 * happening — and even then, every action it can take is one of the three
 * closed, pre-approved, already-existing, already-reversible mechanisms
 * named in `auto-execution-policy.ts`. Nothing here invents a new kind of
 * mutation: `RECURRING_INVOICE_AUTO_GENERATE`/`RECURRING_BILL_AUTO_GENERATE`
 * call the exact same `RecurringInvoiceService.generateDue`/
 * `RecurringBillService.generateDue` a human's "Generate due" button already
 * calls; `BANK_RECONCILIATION_AUTO_MATCH` calls the exact same
 * `ReconciliationService.confirmMatch` a human's "Confirm match" click
 * already calls, and ONLY on a deterministic, same-day, exact-amount
 * candidate (confidence 1.0) — never an AI-scored `FuzzyReconciliationService`
 * suggestion, however high its reported confidence, because a probabilistic
 * judgment is not the "previously human-approved category" master spec §76
 * describes (see docs/ai-agents.md §3b).
 *
 * **No job queue exists in this codebase** (see docs/roadmap.md), so this is
 * the on-demand precursor to real scheduling — the exact same honest
 * limitation `RecurringInvoiceService.generateDue` itself already documents.
 * `runPendingAutoExecutions` is called from the Settings page's "Run
 * automated actions now" control and from the AI Financial Controller's own
 * conversation turn (see `financial-controller-service.ts`), so an
 * organization that has whitelisted an action type gets it executed the
 * next time anyone naturally touches either surface, not on a background
 * timer. Every action type's policy check happens fresh, inline, right
 * before that action type's own mechanism runs — never once at the top of
 * the function and reused — so the emergency stop mid-run (or a whitelist
 * change mid-run) takes effect for the very next action type checked.
 *
 * **Who acts.** `actor` is the real, authenticated, signed-in user who
 * triggered this check — never a synthetic "system" identity with elevated
 * permissions. Every underlying call (`generateDue`, `confirmMatch`, ...)
 * asserts the same real permission it always has; a user who lacks
 * `recurring_invoice:manage` simply has that one action type skipped for
 * them (caught below), exactly like `financial-controller-service.ts`'s
 * dimension-listing fallback never crashes the whole operation over one
 * missing permission.
 */

export interface AutoExecutionResult {
  actionType: AutoApprovedActionType;
  executed: number;
  skippedReason?: string;
}

async function recordAutoExecution(
  actor: Actor,
  params: {
    actionType: AutoApprovedActionType;
    entityType: string;
    entityId: string;
    confidence?: string;
    model?: string;
    autonomyLevel: number;
    label: string;
  },
): Promise<void> {
  await withTenant(actor.organizationId, async (tx) => {
    await tx.insert(aiAutoExecutions).values({
      organizationId: actor.organizationId,
      actionType: params.actionType,
      entityType: params.entityType,
      entityId: params.entityId,
      confidence: params.confidence,
      model: params.model,
      autonomyLevel: params.autonomyLevel,
      triggeredByUserId: actor.userId,
    });

    // Master spec §44's "for AI actions also store: agent, model,
    // confidence, proposed action, approver, outcome" — `approver` here
    // truthfully records that this was auto-approved under org policy, NOT
    // a human clicking confirm (contrast `draft-proposal-service.ts`'s
    // `ai_controller.draft_confirmed`, whose approver really is a human).
    await AuditService.record(tx, { ...actor, type: "AI" }, {
      action: "ai_controller.auto_executed",
      entityType: params.entityType,
      entityId: params.entityId,
      after: { actionType: params.actionType, label: params.label },
      metadata: {
        agent: "AutoExecutionService",
        model: params.model ?? null,
        confidence: params.confidence ?? null,
        proposedAction: params.label,
        approver: `auto-approved under org policy (autonomy level ${params.autonomyLevel}, action type ${params.actionType} explicitly whitelisted)`,
        outcome: "executed",
        triggeredByUserId: actor.userId,
      },
    });
  });
}

async function runRecurringInvoiceAutoGeneration(actor: Actor, level: number): Promise<number> {
  const generated = await RecurringInvoiceService.generateDue(actor);
  for (const g of generated) {
    await recordAutoExecution(actor, {
      actionType: "RECURRING_INVOICE_AUTO_GENERATE",
      entityType: "Invoice",
      entityId: g.invoiceId,
      autonomyLevel: level,
      label: `Auto-generated draft invoice ${g.invoiceNumber} from a due recurring template`,
    });
  }
  return generated.length;
}

async function runRecurringBillAutoGeneration(actor: Actor, level: number): Promise<number> {
  const generated = await RecurringBillService.generateDue(actor);
  for (const g of generated) {
    await recordAutoExecution(actor, {
      actionType: "RECURRING_BILL_AUTO_GENERATE",
      entityType: "Bill",
      entityId: g.billId,
      autonomyLevel: level,
      label: `Auto-generated draft bill ${g.billNumber} from a due recurring template`,
    });
  }
  return generated.length;
}

/** Only ever auto-confirms a deterministic, same-day, exact-amount candidate (confidence 1.0) — see this module's doc comment. */
async function runBankReconciliationAutoMatch(actor: Actor, level: number): Promise<number> {
  let executed = 0;
  const bankAccounts = await BankAccountService.list(actor);
  for (const account of bankAccounts) {
    const unreconciled = await ReconciliationService.listUnreconciled(actor, account.id);
    for (const txn of unreconciled) {
      const candidates = await ReconciliationService.findCandidateMatches(actor, txn.id);
      const exact = candidates.filter((c) => c.confidence === 1);
      // Auto-confirm only an unambiguous, single, perfect candidate — never
      // guess between two same-day exact-amount lines, exactly like
      // `write-tools.ts` refuses an ambiguous name match rather than
      // picking one.
      if (exact.length !== 1) continue;
      const match = exact[0]!;

      await ReconciliationService.confirmMatch(actor, txn.id, match.journalLineId);
      await recordAutoExecution(actor, {
        actionType: "BANK_RECONCILIATION_AUTO_MATCH",
        entityType: "BankTransaction",
        entityId: txn.id,
        confidence: "1.000",
        autonomyLevel: level,
        label: `Auto-confirmed bank transaction match to journal entry ${match.entryNumber} (${match.explanation})`,
      });
      executed += 1;
    }
  }
  return executed;
}

const RUNNERS: Record<AutoApprovedActionType, (actor: Actor, level: number) => Promise<number>> = {
  RECURRING_INVOICE_AUTO_GENERATE: runRecurringInvoiceAutoGeneration,
  RECURRING_BILL_AUTO_GENERATE: runRecurringBillAutoGeneration,
  BANK_RECONCILIATION_AUTO_MATCH: runBankReconciliationAutoMatch,
};

export const AutoExecutionService = {
  /**
   * Checks every auto-approvable action type's policy FRESH (see
   * `isAutoExecutionApproved`'s doc comment) and runs the ones that are
   * currently both Level 3/4 AND explicitly whitelisted. An action type a
   * human actor lacks the underlying permission for is skipped, not thrown —
   * this must never crash the whole check over one missing permission.
   */
  async runPendingAutoExecutions(actor: Actor): Promise<AutoExecutionResult[]> {
    const results: AutoExecutionResult[] = [];
    for (const actionType of Object.keys(RUNNERS) as AutoApprovedActionType[]) {
      const { approved, level } = await isAutoExecutionApproved(actor.organizationId, actionType);
      if (!approved) {
        results.push({ actionType, executed: 0, skippedReason: level < 3 ? "autonomy level below 3" : "not whitelisted" });
        continue;
      }
      try {
        const executed = await RUNNERS[actionType](actor, level);
        results.push({ actionType, executed });
      } catch (err) {
        if (err instanceof PermissionDeniedError) {
          results.push({ actionType, executed: 0, skippedReason: `actor lacks "${err.permission}"` });
          continue;
        }
        throw err;
      }
    }
    return results;
  },

  /** Entity ids auto-executed for `entityType` — used by invoice/bill lists (and anywhere else) to render an "AI auto" badge. */
  async listAutoExecutedEntityIds(organizationId: string, entityType: string): Promise<Set<string>> {
    return withTenant(organizationId, async (tx) => {
      const rows = await tx
        .select({ entityId: aiAutoExecutions.entityId })
        .from(aiAutoExecutions)
        .where(and(eq(aiAutoExecutions.organizationId, organizationId), eq(aiAutoExecutions.entityType, entityType)));
      return new Set(rows.map((r) => r.entityId));
    });
  },

  /** Recent auto-executions for the Daily Finance Brief / audit surfaces. */
  async listRecent(organizationId: string, limit = 20) {
    return withTenant(organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(aiAutoExecutions)
        .where(eq(aiAutoExecutions.organizationId, organizationId))
        .orderBy(aiAutoExecutions.createdAt)
        .limit(limit);
      return rows;
    });
  },

  /**
   * Master spec §77's "undo" for whatever got auto-executed. Never a
   * destructive edit: an auto-generated invoice/bill is still a plain DRAFT,
   * so undo is the exact same `InvoiceService.deleteDraft`/
   * `BillService.deleteDraft` a human deleting any other draft would call;
   * an auto-confirmed bank match is reverted via
   * `ReconciliationService.unmatch` (never `PostingService.reverseEntry`,
   * because nothing was posted — see that method's own doc comment).
   */
  async undo(actor: Actor, autoExecutionId: string): Promise<void> {
    const row = await withTenant(actor.organizationId, async (tx) => {
      const [r] = await tx
        .select()
        .from(aiAutoExecutions)
        .where(and(eq(aiAutoExecutions.id, autoExecutionId), eq(aiAutoExecutions.organizationId, actor.organizationId)));
      return r ?? null;
    });
    if (!row) throw new Error(`Auto-execution ${autoExecutionId} was not found in this organization.`);
    if (row.reversedAt) return; // Already undone — idempotent.

    if (row.actionType === "RECURRING_INVOICE_AUTO_GENERATE") {
      await InvoiceService.deleteDraft(actor, row.entityId);
    } else if (row.actionType === "RECURRING_BILL_AUTO_GENERATE") {
      await BillService.deleteDraft(actor, row.entityId);
    } else {
      await ReconciliationService.unmatch(actor, row.entityId);
    }

    await withTenant(actor.organizationId, async (tx) => {
      await tx
        .update(aiAutoExecutions)
        .set({ reversedAt: new Date(), reversedByUserId: actor.userId })
        .where(eq(aiAutoExecutions.id, autoExecutionId));

      await AuditService.record(tx, actor, {
        action: "ai_controller.auto_execution_undone",
        entityType: row.entityType,
        entityId: row.entityId,
        before: { reversedAt: null },
        after: { reversedAt: new Date().toISOString(), reversedByUserId: actor.userId },
      });
    });
  },
};

/** Re-exported for callers that only need the permission-free level check without triggering anything — e.g. the settings UI deciding whether to show the "Run now" button at all. */
export async function getAutonomyLevelForDisplay(organizationId: string): Promise<number> {
  return AutonomySettingsService.getLevel(organizationId);
}
