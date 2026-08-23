import Decimal from "decimal.js";
import { and, eq, gte, lte, notInArray, sql } from "drizzle-orm";
import { bankAccounts, bankTransactions, journalEntries, journalLines } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import { BankTransactionAlreadyMatchedError, BankTransactionNotFoundError } from "./errors";
import type { MatchCandidate } from "./types";

/** How many days either side of a bank transaction's date to look for a matching journal line. */
const MATCH_WINDOW_DAYS = 10;

function daysBetween(a: Date, b: Date): number {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

async function loadBankTransaction(tx: TenantDb, organizationId: string, bankTransactionId: string) {
  const [row] = await tx
    .select({ transaction: bankTransactions, bankAccount: bankAccounts })
    .from(bankTransactions)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
    .where(and(eq(bankTransactions.id, bankTransactionId), eq(bankTransactions.organizationId, organizationId)));
  if (!row) throw new BankTransactionNotFoundError(bankTransactionId);
  return row;
}

export const ReconciliationService = {
  async listUnreconciled(actor: Actor, bankAccountId: string) {
    assertPermission(actor, "bank_transaction:reconcile");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.organizationId, actor.organizationId),
            eq(bankTransactions.bankAccountId, bankAccountId),
            eq(bankTransactions.status, "UNMATCHED"),
          ),
        )
        .orderBy(bankTransactions.postedDate),
    );
  },

  /**
   * Deterministic candidate matching: exact-amount journal lines on the bank
   * account's GL account, posted, not already claimed by another bank
   * transaction, within a date window — ranked by date proximity. Kept
   * rule-based rather than an opaque model score so every result carries a
   * plain-language reason a bookkeeper can verify at a glance; a
   * higher-recall AI-assisted pass (fuzzy description matching for
   * transactions with no exact-amount candidate) is a natural follow-up
   * layered on top of this, not a replacement for it — see
   * docs/decisions/0006-bank-feed-abstraction.md.
   */
  async findCandidateMatches(actor: Actor, bankTransactionId: string): Promise<MatchCandidate[]> {
    assertPermission(actor, "bank_transaction:reconcile");
    return withTenant(actor.organizationId, async (tx) => {
      const { transaction, bankAccount } = await loadBankTransaction(tx, actor.organizationId, bankTransactionId);

      const amount = new Decimal(transaction.amount);
      const isInflow = amount.isPositive();
      const absAmount = amount.abs().toFixed(4);

      const windowStart = new Date(transaction.postedDate);
      windowStart.setUTCDate(windowStart.getUTCDate() - MATCH_WINDOW_DAYS);
      const windowEnd = new Date(transaction.postedDate);
      windowEnd.setUTCDate(windowEnd.getUTCDate() + MATCH_WINDOW_DAYS);

      const alreadyMatched = await tx
        .select({ id: bankTransactions.matchedJournalLineId })
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.organizationId, actor.organizationId),
            sql`${bankTransactions.matchedJournalLineId} IS NOT NULL`,
          ),
        );
      const matchedLineIds = alreadyMatched.map((r) => r.id!).filter(Boolean);

      const sideColumn = isInflow ? journalLines.debit : journalLines.credit;

      const candidates = await tx
        .select({
          lineId: journalLines.id,
          entryId: journalEntries.id,
          entryNumber: journalEntries.entryNumber,
          postingDate: journalEntries.postingDate,
          memo: journalEntries.memo,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .where(
          and(
            eq(journalLines.organizationId, actor.organizationId),
            eq(journalLines.accountId, bankAccount.glAccountId),
            eq(journalEntries.status, "POSTED"),
            eq(sideColumn, absAmount),
            gte(journalEntries.postingDate, windowStart),
            lte(journalEntries.postingDate, windowEnd),
            matchedLineIds.length > 0 ? notInArray(journalLines.id, matchedLineIds) : undefined,
          ),
        );

      return candidates
        .map((c): MatchCandidate => {
          const dayDiff = daysBetween(new Date(c.postingDate), new Date(transaction.postedDate));
          const confidence = dayDiff === 0 ? 1 : Math.max(0.5, 0.9 - dayDiff * 0.04);
          const explanation =
            dayDiff === 0
              ? `Amount (${absAmount} ${bankAccount.currency}) and date match exactly.`
              : `Amount matches exactly (${absAmount} ${bankAccount.currency}); posting date is ${dayDiff} day${dayDiff === 1 ? "" : "s"} away.`;
          return {
            journalLineId: c.lineId,
            journalEntryId: c.entryId,
            entryNumber: c.entryNumber,
            postingDate: new Date(c.postingDate),
            memo: c.memo,
            amount: isInflow ? c.debit : c.credit,
            confidence,
            explanation,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);
    });
  },

  /** Links a bank transaction to an existing posted journal line — no new journal entry is created. */
  async confirmMatch(actor: Actor, bankTransactionId: string, journalLineId: string) {
    assertPermission(actor, "bank_transaction:reconcile");
    return withTenant(actor.organizationId, async (tx) => {
      const { transaction, bankAccount } = await loadBankTransaction(tx, actor.organizationId, bankTransactionId);
      if (transaction.status !== "UNMATCHED") {
        throw new BankTransactionAlreadyMatchedError(bankTransactionId);
      }

      const [line] = await tx
        .select({ id: journalLines.id, debit: journalLines.debit, credit: journalLines.credit })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .where(
          and(
            eq(journalLines.id, journalLineId),
            eq(journalLines.organizationId, actor.organizationId),
            eq(journalLines.accountId, bankAccount.glAccountId),
            eq(journalEntries.status, "POSTED"),
          ),
        );
      if (!line) {
        throw new Error(`Journal line ${journalLineId} was not found on this bank account's ledger account.`);
      }

      const amount = new Decimal(transaction.amount);
      const expectedSide = amount.isPositive() ? line.debit : line.credit;
      if (!new Decimal(expectedSide).equals(amount.abs())) {
        throw new Error("The selected journal line's amount does not match this transaction.");
      }

      const [updated] = await tx
        .update(bankTransactions)
        .set({
          status: "RECONCILED",
          matchedJournalLineId: journalLineId,
          matchedById: actor.userId,
          matchedAt: new Date(),
        })
        .where(eq(bankTransactions.id, bankTransactionId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "bank_transaction.matched",
        entityType: "BankTransaction",
        entityId: bankTransactionId,
        after: { matchedJournalLineId: journalLineId },
      });

      return updated;
    });
  },

  /**
   * Posts a brand-new balanced journal entry for a transaction with no
   * existing counterpart (an expense, a bank fee, an unrecorded deposit) —
   * one side is always the bank account's own GL account, so it can never
   * be posted unbalanced. Goes through `PostingService.postJournal`, so
   * every Phase 1 invariant (period lock, active accounts, debit=credit)
   * still applies; this is not a side door around them.
   */
  async createJournalFromTransaction(
    actor: Actor,
    bankTransactionId: string,
    categorization: { categorizedAccountId: string; contactId?: string; taxCodeId?: string; memo?: string },
  ) {
    assertPermission(actor, "bank_transaction:reconcile");

    const { transaction, bankAccount } = await withTenant(actor.organizationId, (tx) =>
      loadBankTransaction(tx, actor.organizationId, bankTransactionId),
    );
    if (transaction.status !== "UNMATCHED") {
      throw new BankTransactionAlreadyMatchedError(bankTransactionId);
    }

    const amount = new Decimal(transaction.amount);
    const absAmount = amount.abs().toFixed(4);
    const isInflow = amount.isPositive();

    const posted = await PostingService.postJournal(actor, {
      postingDate: transaction.postedDate,
      memo: categorization.memo ?? transaction.description,
      sourceType: "BANK_TRANSACTION",
      lines: [
        {
          accountId: bankAccount.glAccountId,
          currency: bankAccount.currency,
          debit: isInflow ? absAmount : undefined,
          credit: isInflow ? undefined : absAmount,
        },
        {
          accountId: categorization.categorizedAccountId,
          currency: bankAccount.currency,
          debit: isInflow ? undefined : absAmount,
          credit: isInflow ? absAmount : undefined,
          contactId: categorization.contactId,
          taxCodeId: categorization.taxCodeId,
        },
      ],
    });

    return withTenant(actor.organizationId, async (tx) => {
      const [bankLine] = await tx
        .select({ id: journalLines.id })
        .from(journalLines)
        .where(
          and(
            eq(journalLines.journalEntryId, posted.entryId),
            eq(journalLines.accountId, bankAccount.glAccountId),
          ),
        );
      if (!bankLine) throw new Error("Failed to locate the posted bank-side journal line.");

      const [updated] = await tx
        .update(bankTransactions)
        .set({
          status: "RECONCILED",
          categorizedAccountId: categorization.categorizedAccountId,
          contactId: categorization.contactId ?? null,
          matchedJournalLineId: bankLine.id,
          matchedById: actor.userId,
          matchedAt: new Date(),
        })
        .where(eq(bankTransactions.id, bankTransactionId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "bank_transaction.posted",
        entityType: "BankTransaction",
        entityId: bankTransactionId,
        after: { journalEntryId: posted.entryId, entryNumber: posted.entryNumber },
      });

      return { ...updated!, journalEntry: posted };
    });
  },

  /** Marks a transaction as deliberately not reconciled (a duplicate export, an out-of-scope line) — no ledger effect. */
  async exclude(actor: Actor, bankTransactionId: string, reason?: string) {
    assertPermission(actor, "bank_transaction:reconcile");
    return withTenant(actor.organizationId, async (tx) => {
      const { transaction } = await loadBankTransaction(tx, actor.organizationId, bankTransactionId);
      if (transaction.status !== "UNMATCHED") {
        throw new BankTransactionAlreadyMatchedError(bankTransactionId);
      }

      const [updated] = await tx
        .update(bankTransactions)
        .set({ status: "EXCLUDED", matchedById: actor.userId, matchedAt: new Date() })
        .where(eq(bankTransactions.id, bankTransactionId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "bank_transaction.excluded",
        entityType: "BankTransaction",
        entityId: bankTransactionId,
        after: { reason: reason ?? null },
      });

      return updated;
    });
  },
};
