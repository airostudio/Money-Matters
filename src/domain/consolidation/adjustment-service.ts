import { entityGroupAdjustmentLines, entityGroupAdjustments } from "@/db/schema";
import { withUserScope, type UserScopeDb } from "@/db/user-scope";
import { Money } from "@/domain/money/money";
import { GroupAuditService } from "./group-audit";
import { AdjustmentAlreadyReversedError, AdjustmentNotFoundError, InvalidAdjustmentError } from "./errors";
import type { GroupActor } from "./entity-access";
import { loadGroupSnapshotIn } from "./group-snapshot";

export interface AdjustmentLineInput {
  groupAccountId: string;
  /** Exact decimal string with at most 4 decimal places. Give exactly one of debit / credit. */
  debit?: string;
  credit?: string;
  memo?: string;
}

export interface CreateAdjustmentInput {
  kind: "ELIMINATION" | "ADJUSTMENT";
  effectiveDate: Date;
  description: string;
  /** Why — mandatory, kept forever in the append-only record. */
  reason: string;
  lines: AdjustmentLineInput[];
}

const AMOUNT = /^\d+(\.\d{1,4})?$/;
const CURRENCY = "GROUP";

function parseAmount(raw: string | undefined, label: string): Money {
  if (raw === undefined || raw === "") return Money.zero(CURRENCY);
  const trimmed = raw.trim();
  if (!AMOUNT.test(trimmed)) {
    throw new InvalidAdjustmentError(`${label} must be a plain decimal amount with at most 4 decimal places.`);
  }
  return Money.of(trimmed, CURRENCY);
}

/**
 * Manual group-level elimination / consolidation adjustments — the only
 * "journals" consolidation owns. They are rows in group-level, append-only
 * tables (`entity_group_adjustments` + `_lines`) that reference GROUP accounts,
 * read ONLY by the consolidated reports. They are never `journal_entries` of
 * any entity: nothing here opens a tenant transaction, and an entity's ledger
 * and trial balance are byte-identical before and after (proved by a test).
 *
 * Append-only: mm_app has INSERT + SELECT only. An adjustment is undone by
 * `reverse`, which inserts a NEW mirror-image adjustment pointing back at the
 * original; the report then nets the two. Every adjustment must balance
 * exactly (total debits = total credits, decimal arithmetic), which is what
 * keeps the consolidated Balance Sheet in balance after adjustments.
 */
export const AdjustmentService = {
  async create(actor: GroupActor, groupId: string, input: CreateAdjustmentInput) {
    const description = input.description.trim();
    const reason = input.reason.trim();
    if (!description) throw new InvalidAdjustmentError("A description is required.");
    if (!reason) throw new InvalidAdjustmentError("A reason is required — adjustments are permanent and must say why.");
    if (Number.isNaN(input.effectiveDate.getTime())) throw new InvalidAdjustmentError("A valid effective date is required.");
    if (input.lines.length < 2) throw new InvalidAdjustmentError("An adjustment needs at least two lines.");

    let debits = Money.zero(CURRENCY);
    let credits = Money.zero(CURRENCY);
    const parsed = input.lines.map((l, i) => {
      const debit = parseAmount(l.debit, `Line ${i + 1} debit`);
      const credit = parseAmount(l.credit, `Line ${i + 1} credit`);
      if (debit.isPositive() === credit.isPositive()) {
        throw new InvalidAdjustmentError(`Line ${i + 1} must have exactly one of debit or credit, greater than zero.`);
      }
      debits = debits.add(debit);
      credits = credits.add(credit);
      return { groupAccountId: l.groupAccountId, debit, credit, memo: l.memo?.trim() || null };
    });
    if (!debits.equals(credits)) {
      throw new InvalidAdjustmentError(
        `The adjustment does not balance: debits ${debits.toString()} and credits ${credits.toString()} differ.`,
      );
    }

    return withUserScope(actor.userId, async (tx) => {
      const snapshot = await loadGroupSnapshotIn(tx, actor.userId, groupId);
      const known = new Set(snapshot.config.groupAccounts.map((g) => g.id));
      for (const l of parsed) {
        if (!known.has(l.groupAccountId)) throw new InvalidAdjustmentError("An adjustment line names an account that is not in this group's chart.");
      }
      return insertAdjustment(tx, actor, groupId, {
        kind: input.kind,
        effectiveDate: input.effectiveDate,
        description,
        reason,
        reversesAdjustmentId: null,
        lines: parsed.map((l) => ({ ...l, debit: l.debit.toString(), credit: l.credit.toString() })),
      });
    });
  },

  /** Inserts the mirror image of an adjustment. The original is never touched. */
  async reverse(actor: GroupActor, groupId: string, adjustmentId: string, input: { reason: string; effectiveDate?: Date }) {
    const reason = input.reason.trim();
    if (!reason) throw new InvalidAdjustmentError("A reason is required to reverse an adjustment.");
    return withUserScope(actor.userId, async (tx) => {
      const snapshot = await loadGroupSnapshotIn(tx, actor.userId, groupId);
      const original = snapshot.config.adjustments.find((a) => a.id === adjustmentId);
      if (!original) throw new AdjustmentNotFoundError();
      if (original.reversesAdjustmentId) throw new InvalidAdjustmentError("A reversal cannot itself be reversed — post a new adjustment instead.");
      if (snapshot.config.adjustments.some((a) => a.reversesAdjustmentId === adjustmentId)) throw new AdjustmentAlreadyReversedError();

      return insertAdjustment(tx, actor, groupId, {
        kind: original.kind,
        effectiveDate: input.effectiveDate ?? original.effectiveDate,
        description: `Reversal of: ${original.description}`,
        reason,
        reversesAdjustmentId: original.id,
        lines: original.lines.map((l) => ({
          groupAccountId: l.groupAccountId,
          debit: l.credit,
          credit: l.debit,
          memo: l.memo ?? null,
        })),
      });
    });
  },

  async list(actor: GroupActor, groupId: string) {
    return withUserScope(actor.userId, async (tx) => {
      const snapshot = await loadGroupSnapshotIn(tx, actor.userId, groupId);
      const accounts = new Map(snapshot.config.groupAccounts.map((g) => [g.id, g]));
      const reversedBy = new Map(
        snapshot.config.adjustments.filter((a) => a.reversesAdjustmentId).map((a) => [a.reversesAdjustmentId!, a.id]),
      );
      return snapshot.config.adjustments.map((a) => ({
        ...a,
        reversedById: reversedBy.get(a.id) ?? null,
        lines: a.lines.map((l) => ({ ...l, account: accounts.get(l.groupAccountId) ?? null })),
      }));
    });
  },
};

async function insertAdjustment(
  tx: UserScopeDb,
  actor: GroupActor,
  groupId: string,
  data: {
    kind: "ELIMINATION" | "ADJUSTMENT";
    effectiveDate: Date;
    description: string;
    reason: string;
    reversesAdjustmentId: string | null;
    lines: Array<{ groupAccountId: string; debit: string; credit: string; memo: string | null }>;
  },
) {
  const [header] = await tx
    .insert(entityGroupAdjustments)
    .values({
      groupId,
      ownerUserId: actor.userId,
      kind: data.kind,
      effectiveDate: data.effectiveDate,
      description: data.description,
      reason: data.reason,
      reversesAdjustmentId: data.reversesAdjustmentId,
      createdByUserId: actor.userId,
    })
    .returning();
  if (!header) throw new Error("Failed to record the adjustment.");

  await tx.insert(entityGroupAdjustmentLines).values(
    data.lines.map((l) => ({
      adjustmentId: header.id,
      groupId,
      ownerUserId: actor.userId,
      groupAccountId: l.groupAccountId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
    })),
  );

  await GroupAuditService.record(tx, {
    groupId,
    ownerUserId: actor.userId,
    actorUserId: actor.userId,
    actorType: actor.type,
    action: data.reversesAdjustmentId ? "entity_group.adjustment_reversed" : "entity_group.adjustment_created",
    entityType: "EntityGroupAdjustment",
    entityId: header.id,
    after: {
      kind: data.kind,
      effectiveDate: data.effectiveDate.toISOString(),
      description: data.description,
      lines: data.lines,
    },
    metadata: { reason: data.reason, reversesAdjustmentId: data.reversesAdjustmentId },
  });
  return header;
}
