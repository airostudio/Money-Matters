import { and, eq, inArray, lte, gte } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accounts,
  dimensionValues,
  fiscalPeriods,
  journalEntries,
  journalLineDimensions,
  journalLines,
  organizations,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { nextEntryNumber } from "./numbering";
import {
  EntryNotFoundError,
  ImmutableEntryError,
  InvalidJournalLineError,
  PeriodLockedError,
  UnbalancedJournalError,
} from "./errors";
import type { JournalEntryDraft, JournalLineDraft, PostedJournalResult } from "./types";

interface PreparedLine {
  accountId: string;
  contactId: string | null;
  taxCodeId: string | null;
  memo: string | null;
  currency: string;
  exchangeRate: string;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
  dimensionValueIds: string[];
}

async function loadOrganization(tx: TenantDb, organizationId: string) {
  const [org] = await tx
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  if (!org) {
    throw new Error(`Organization ${organizationId} not found.`);
  }
  return org;
}

async function assertAccountsBelongToOrg(
  tx: TenantDb,
  organizationId: string,
  accountIds: string[],
) {
  const rows = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds)));

  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of accountIds) {
    const row = found.get(id);
    if (!row) {
      throw new InvalidJournalLineError(`Account ${id} does not exist in this organization.`);
    }
    if (!row.isActive) {
      throw new InvalidJournalLineError(`Account ${id} is inactive and cannot be posted to.`);
    }
  }
}

function prepareLine(line: JournalLineDraft, index: number, baseCurrency: string): PreparedLine {
  const debit = Money.of(line.debit ?? "0", line.currency);
  const credit = Money.of(line.credit ?? "0", line.currency);

  if (debit.isNegative() || credit.isNegative()) {
    throw new InvalidJournalLineError(`Line ${index + 1}: debit/credit cannot be negative.`);
  }
  if (debit.isPositive() === credit.isPositive()) {
    throw new InvalidJournalLineError(
      `Line ${index + 1}: exactly one of debit or credit must be a positive amount.`,
    );
  }

  const exchangeRate = new Decimal(line.exchangeRate ?? "1");
  if (exchangeRate.lessThanOrEqualTo(0)) {
    throw new InvalidJournalLineError(`Line ${index + 1}: exchangeRate must be positive.`);
  }

  const baseDebit = debit.convert(exchangeRate, baseCurrency);
  const baseCredit = credit.convert(exchangeRate, baseCurrency);

  return {
    accountId: line.accountId,
    contactId: line.contactId ?? null,
    taxCodeId: line.taxCodeId ?? null,
    memo: line.memo ?? null,
    currency: line.currency,
    exchangeRate: exchangeRate.toFixed(8),
    debit: debit.toString(),
    credit: credit.toString(),
    baseDebit: baseDebit.toString(),
    baseCredit: baseCredit.toString(),
    dimensionValueIds: line.dimensionValueIds ?? [],
  };
}

function assertBalanced(lines: PreparedLine[], baseCurrency: string) {
  const totalDebit = lines.reduce(
    (sum, l) => sum.add(Money.of(l.baseDebit, baseCurrency)),
    Money.zero(baseCurrency),
  );
  const totalCredit = lines.reduce(
    (sum, l) => sum.add(Money.of(l.baseCredit, baseCurrency)),
    Money.zero(baseCurrency),
  );
  if (!totalDebit.equals(totalCredit)) {
    throw new UnbalancedJournalError(
      `Journal entry does not balance: total debit ${totalDebit.toString()} != total credit ${totalCredit.toString()} (${baseCurrency}).`,
    );
  }
}

async function findFiscalPeriod(tx: TenantDb, organizationId: string, postingDate: Date) {
  const [period] = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.organizationId, organizationId),
        lte(fiscalPeriods.startDate, postingDate),
        gte(fiscalPeriods.endDate, postingDate),
      ),
    );
  return period ?? null;
}

async function assertPeriodOpenForDate(tx: TenantDb, organizationId: string, postingDate: Date) {
  const period = await findFiscalPeriod(tx, organizationId, postingDate);
  if (period && period.status !== "OPEN") {
    throw new PeriodLockedError(period.label);
  }
  return period;
}

async function insertEntryWithLines(
  tx: TenantDb,
  actor: Actor,
  draft: JournalEntryDraft,
  status: "DRAFT" | "POSTED",
  extra: { reversalOfId?: string } = {},
): Promise<PostedJournalResult> {
  if (draft.lines.length < 2) {
    throw new UnbalancedJournalError("A journal entry needs at least two lines.");
  }

  const org = await loadOrganization(tx, actor.organizationId);
  const accountIds = [...new Set(draft.lines.map((l) => l.accountId))];
  await assertAccountsBelongToOrg(tx, actor.organizationId, accountIds);

  const preparedLines = draft.lines.map((line, i) => prepareLine(line, i, org.baseCurrency));
  assertBalanced(preparedLines, org.baseCurrency);

  const period =
    status === "POSTED"
      ? await assertPeriodOpenForDate(tx, actor.organizationId, draft.postingDate)
      : await findFiscalPeriod(tx, actor.organizationId, draft.postingDate);

  const entryNumber = await nextEntryNumber(tx, actor.organizationId);
  const now = new Date();

  const [entry] = await tx
    .insert(journalEntries)
    .values({
      organizationId: actor.organizationId,
      entryNumber,
      postingDate: draft.postingDate,
      memo: draft.memo ?? null,
      status,
      sourceType: draft.sourceType ?? "MANUAL",
      fiscalPeriodId: period?.id ?? null,
      reversalOfId: extra.reversalOfId ?? null,
      createdById: actor.userId,
      updatedById: actor.userId,
      postedAt: status === "POSTED" ? now : null,
      postedById: status === "POSTED" ? actor.userId : null,
    })
    .returning();

  if (!entry) {
    throw new Error("Failed to insert journal entry.");
  }

  const insertedLines = await tx
    .insert(journalLines)
    .values(
      preparedLines.map((line, i) => ({
        organizationId: actor.organizationId,
        journalEntryId: entry.id,
        lineNumber: i + 1,
        accountId: line.accountId,
        contactId: line.contactId,
        taxCodeId: line.taxCodeId,
        memo: line.memo,
        currency: line.currency,
        exchangeRate: line.exchangeRate,
        debit: line.debit,
        credit: line.credit,
        baseDebit: line.baseDebit,
        baseCredit: line.baseCredit,
        createdById: actor.userId,
      })),
    )
    .returning();

  const dimensionRows = insertedLines.flatMap((insertedLine, i) => {
    const dimensionValueIds = preparedLines[i]?.dimensionValueIds ?? [];
    return dimensionValueIds.map((dimensionValueId) => ({
      organizationId: actor.organizationId,
      journalLineId: insertedLine.id,
      dimensionValueId,
    }));
  });
  if (dimensionRows.length > 0) {
    const dvRows = await tx
      .select({ id: dimensionValues.id, dimensionId: dimensionValues.dimensionId })
      .from(dimensionValues)
      .where(
        inArray(
          dimensionValues.id,
          dimensionRows.map((d) => d.dimensionValueId),
        ),
      );
    const dimensionIdByValueId = new Map(dvRows.map((d) => [d.id, d.dimensionId]));
    await tx.insert(journalLineDimensions).values(
      dimensionRows.map((d) => ({
        organizationId: actor.organizationId,
        journalLineId: d.journalLineId,
        dimensionValueId: d.dimensionValueId,
        dimensionId: dimensionIdByValueId.get(d.dimensionValueId) as string,
      })),
    );
  }

  await AuditService.record(tx, actor, {
    action: status === "POSTED" ? "journal.posted" : "journal.draft_created",
    entityType: "JournalEntry",
    entityId: entry.id,
    after: { entryNumber, status, postingDate: draft.postingDate, lines: preparedLines },
  });

  return { entryId: entry.id, entryNumber };
}

export const PostingService = {
  /** Creates a balanced entry in DRAFT status — editable/deletable until posted. */
  async createDraft(actor: Actor, draft: JournalEntryDraft): Promise<PostedJournalResult> {
    assertPermission(actor, "journal:post");
    return withTenant(actor.organizationId, (tx) =>
      insertEntryWithLines(tx, actor, draft, "DRAFT"),
    );
  },

  /** Creates and immediately posts a balanced entry — the common case for tests/seeding/simple flows. */
  async postJournal(actor: Actor, draft: JournalEntryDraft): Promise<PostedJournalResult> {
    assertPermission(actor, "journal:post");
    return withTenant(actor.organizationId, (tx) =>
      insertEntryWithLines(tx, actor, draft, "POSTED"),
    );
  },

  /** Transitions an existing DRAFT entry to POSTED. */
  async postDraft(actor: Actor, entryId: string): Promise<PostedJournalResult> {
    assertPermission(actor, "journal:post");
    return withTenant(actor.organizationId, async (tx) => {
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(eq(journalEntries.id, entryId), eq(journalEntries.organizationId, actor.organizationId)),
        );
      if (!entry) throw new EntryNotFoundError(entryId);
      if (entry.status !== "DRAFT") {
        throw new ImmutableEntryError(`Journal entry ${entry.entryNumber} is not a draft.`);
      }

      const period = await assertPeriodOpenForDate(tx, actor.organizationId, entry.postingDate);
      const now = new Date();

      await tx
        .update(journalEntries)
        .set({
          status: "POSTED",
          fiscalPeriodId: period?.id ?? null,
          postedAt: now,
          postedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: now,
        })
        .where(eq(journalEntries.id, entryId));

      await AuditService.record(tx, actor, {
        action: "journal.posted",
        entityType: "JournalEntry",
        entityId: entry.id,
        before: { status: "DRAFT" },
        after: { status: "POSTED" },
      });

      return { entryId: entry.id, entryNumber: entry.entryNumber };
    });
  },

  /** Deletes a DRAFT entry outright — posted entries can never be deleted, only reversed. */
  async deleteDraft(actor: Actor, entryId: string): Promise<void> {
    assertPermission(actor, "journal:post");
    await withTenant(actor.organizationId, async (tx) => {
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(eq(journalEntries.id, entryId), eq(journalEntries.organizationId, actor.organizationId)),
        );
      if (!entry) throw new EntryNotFoundError(entryId);
      if (entry.status !== "DRAFT") {
        throw new ImmutableEntryError(`Journal entry ${entry.entryNumber} is not a draft and cannot be deleted.`);
      }

      await tx.delete(journalEntries).where(eq(journalEntries.id, entryId));

      await AuditService.record(tx, actor, {
        action: "journal.draft_deleted",
        entityType: "JournalEntry",
        entityId: entry.id,
        before: { entryNumber: entry.entryNumber, status: entry.status },
      });
    });
  },

  /**
   * Reverses a POSTED entry: creates a new POSTED entry with every line's
   * debit/credit swapped, linked via reversalOfId, and marks the original
   * REVERSED. The original's lines are never modified — see
   * docs/accounting-engine.md §1.
   */
  async reverseEntry(
    actor: Actor,
    entryId: string,
    reason: string,
    reversalDate?: Date,
  ): Promise<PostedJournalResult> {
    assertPermission(actor, "journal:reverse");
    return withTenant(actor.organizationId, async (tx) => {
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(
          and(eq(journalEntries.id, entryId), eq(journalEntries.organizationId, actor.organizationId)),
        );
      if (!entry) throw new EntryNotFoundError(entryId);
      if (entry.status !== "POSTED") {
        throw new ImmutableEntryError(
          `Journal entry ${entry.entryNumber} is not posted and cannot be reversed.`,
        );
      }

      const originalLines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, entryId))
        .orderBy(journalLines.lineNumber);

      const mirroredLines: JournalLineDraft[] = originalLines.map((line) => {
        const originalDebit = Money.of(line.debit, line.currency);
        const originalCredit = Money.of(line.credit, line.currency);
        return {
          accountId: line.accountId,
          debit: originalCredit.isPositive() ? originalCredit.toString() : undefined,
          credit: originalDebit.isPositive() ? originalDebit.toString() : undefined,
          currency: line.currency,
          exchangeRate: line.exchangeRate,
          contactId: line.contactId ?? undefined,
          taxCodeId: line.taxCodeId ?? undefined,
          memo: line.memo ?? undefined,
        };
      });

      const draft: JournalEntryDraft = {
        postingDate: reversalDate ?? new Date(),
        memo: `Reversal of ${entry.entryNumber}: ${reason}`,
        sourceType: entry.sourceType,
        lines: mirroredLines,
      };

      const result = await insertEntryWithLines(tx, actor, draft, "POSTED", {
        reversalOfId: entry.id,
      });

      await tx
        .update(journalEntries)
        .set({ status: "REVERSED", updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(journalEntries.id, entry.id));

      await AuditService.record(tx, actor, {
        action: "journal.reversed",
        entityType: "JournalEntry",
        entityId: entry.id,
        before: { status: "POSTED" },
        after: { status: "REVERSED", reversalEntryId: result.entryId, reason },
      });

      return result;
    });
  },
};
