import { and, asc, eq, inArray } from "drizzle-orm";
import { depreciationEntries, fixedAssets, organizations } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import { calculateStraightLineDepreciation } from "./depreciation-calculations";
import type { DepreciationRunResult, RunDepreciationInput } from "./types";

function monthBounds(anyDayInMonth: Date): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(Date.UTC(anyDayInMonth.getUTCFullYear(), anyDayInMonth.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(anyDayInMonth.getUTCFullYear(), anyDayInMonth.getUTCMonth() + 1, 0));
  return { periodStart, periodEnd };
}

/**
 * The on-demand precursor to real scheduling (see docs/roadmap.md) for
 * posting periodic depreciation — the fixed-assets mirror of
 * `RecurringInvoiceService.generateDue`/`RecurringBillService.generateDue`:
 * a human-triggered "run depreciation for calendar month X" action, never a
 * background job.
 *
 * **Idempotent per asset per period, structurally, not just by
 * convention**: `depreciation_entries` has a unique index on
 * (`organizationId`, `assetId`, `periodStart`) — see that table's doc
 * comment in src/db/schema.ts. `runForPeriod` checks for an existing row
 * before computing anything for a given asset/period and skips it outright
 * if found, so calling this twice for the same month is a no-op the second
 * time (proven by an integration test that runs the same period twice and
 * asserts only one journal entry and one `depreciation_entries` row per
 * asset exist afterward).
 *
 * **One combined journal entry per run, one line pair per asset with a
 * non-zero charge** — not a separate entry per asset. A business running
 * this monthly across a whole asset register wants one journal to review,
 * not N; `DepreciationRunLineResult[]` in the return value still gives a
 * per-asset breakdown for display even though only one entry was posted. An
 * asset with a $0 charge this period (not yet acquired, or already fully
 * depreciated) still gets a `depreciation_entries` row — necessary for the
 * idempotency check above to ever see it as "already run" — but
 * contributes no line to the journal (`PostingService` rejects a $0
 * debit/credit line as neither a debit nor a credit).
 */
export const DepreciationService = {
  async runForPeriod(actor: Actor, input: RunDepreciationInput): Promise<DepreciationRunResult> {
    assertPermission(actor, "fixed_asset:manage");
    const { periodStart, periodEnd } = monthBounds(input.periodMonth);

    return withTenant(actor.organizationId, async (tx) => {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, actor.organizationId));
      const currency = org?.baseCurrency ?? "AUD";

      const conditions = [eq(fixedAssets.organizationId, actor.organizationId), eq(fixedAssets.status, "ACTIVE")];
      if (input.assetId) conditions.push(eq(fixedAssets.id, input.assetId));

      const assets = await tx
        .select()
        .from(fixedAssets)
        .where(and(...conditions))
        .orderBy(asc(fixedAssets.name));

      const lines: JournalLineDraft[] = [];
      const results: DepreciationRunResult["lines"] = [];
      let total = Money.zero(currency);

      for (const asset of assets) {
        // Idempotency: a row already exists for this (asset, periodStart) —
        // skip it entirely rather than recomputing or re-posting.
        const [already] = await tx
          .select({ id: depreciationEntries.id })
          .from(depreciationEntries)
          .where(
            and(
              eq(depreciationEntries.organizationId, actor.organizationId),
              eq(depreciationEntries.assetId, asset.id),
              eq(depreciationEntries.periodStart, periodStart),
            ),
          );
        if (already) continue;

        const computed = calculateStraightLineDepreciation({
          acquisitionDate: asset.acquisitionDate,
          acquisitionCost: asset.acquisitionCost,
          residualValue: asset.residualValue,
          usefulLifeMonths: asset.usefulLifeMonths,
          accumulatedDepreciationBefore: asset.accumulatedDepreciation,
          periodStart,
          periodEnd,
        });

        const amount = Money.of(computed.amount, currency);

        if (amount.isPositive()) {
          lines.push({ accountId: asset.depreciationExpenseAccountId, debit: amount.toString(), currency });
          lines.push({ accountId: asset.accumulatedDepreciationAccountId, credit: amount.toString(), currency });
          total = total.add(amount);

          await tx
            .update(fixedAssets)
            .set({ accumulatedDepreciation: computed.accumulatedDepreciationAfter, updatedAt: new Date() })
            .where(eq(fixedAssets.id, asset.id));
        }

        const [entry] = await tx
          .insert(depreciationEntries)
          .values({
            organizationId: actor.organizationId,
            assetId: asset.id,
            periodStart,
            periodEnd,
            amount: computed.amount,
            accumulatedDepreciationAfter: computed.accumulatedDepreciationAfter,
            createdById: actor.userId,
          })
          .returning();
        if (!entry) throw new Error("Failed to record depreciation entry.");

        results.push({
          assetId: asset.id,
          assetName: asset.name,
          amount: computed.amount,
          accumulatedDepreciationAfter: computed.accumulatedDepreciationAfter,
        });
      }

      let journalEntryId: string | null = null;
      let entryNumber: string | null = null;

      if (lines.length > 0) {
        const posted = await PostingService.postJournal(actor, {
          postingDate: periodEnd,
          memo: `Depreciation for ${periodStart.toISOString().slice(0, 7)}`,
          sourceType: "MANUAL",
          lines,
        });
        journalEntryId = posted.entryId;
        entryNumber = posted.entryNumber;

        // Link every non-zero row this call just inserted for this period
        // to the entry above. The idempotency check earlier guarantees at
        // most one `depreciation_entries` row per (asset, periodStart)
        // ever exists, so this WHERE can only ever touch rows this exact
        // call inserted a moment ago — a $0 row is deliberately excluded
        // (it has no journal line, so it correctly keeps journalEntryId
        // null).
        const nonZeroAssetIds = results
          .filter((r) => Money.of(r.amount, currency).isPositive())
          .map((r) => r.assetId);
        await tx
          .update(depreciationEntries)
          .set({ journalEntryId: posted.entryId })
          .where(
            and(
              eq(depreciationEntries.organizationId, actor.organizationId),
              eq(depreciationEntries.periodStart, periodStart),
              inArray(depreciationEntries.assetId, nonZeroAssetIds),
            ),
          );

        await AuditService.record(tx, actor, {
          action: "depreciation.run",
          entityType: "JournalEntry",
          entityId: posted.entryId,
          after: {
            periodStart: periodStart.toISOString().slice(0, 10),
            periodEnd: periodEnd.toISOString().slice(0, 10),
            assetsDepreciated: lines.length / 2,
            totalPosted: total.toString(),
          },
        });
      }

      return {
        periodStart: periodStart.toISOString().slice(0, 10),
        periodEnd: periodEnd.toISOString().slice(0, 10),
        lines: results,
        journalEntryId,
        entryNumber,
        totalPosted: total.toString(),
      };
    });
  },
};
