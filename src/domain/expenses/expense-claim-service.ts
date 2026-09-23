import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { accounts, expenseClaimLines, expenseClaims, taxCodes, type expenseClaimStatusEnum } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  ExpenseClaimAlreadyVoidError,
  ExpenseClaimForbiddenError,
  ExpenseClaimNotApprovedError,
  ExpenseClaimNotDraftError,
  ExpenseClaimNotEditableError,
  ExpenseClaimNotFoundError,
  ExpenseClaimNotSubmittedError,
  InvalidExpenseClaimLineError,
  TaxCodeMissingReceivableAccountForExpenseError,
} from "./errors";
import { calculateExpenseClaimTotals } from "./expense-claim-calculations";
import { nextExpenseClaimNumber } from "./numbering";
import type { CreateExpenseClaimInput, MarkReimbursedInput, UpdateExpenseClaimInput } from "./types";

type ExpenseClaimStatus = (typeof expenseClaimStatusEnum.enumValues)[number];

const EDITABLE_STATUSES: ExpenseClaimStatus[] = ["DRAFT"];

/** Whether this actor may act on ANY claim, not just their own (an approver/manager role). */
function isApprover(actor: Actor): boolean {
  return roleHasPermission(actor.role, "expense_claim:approve");
}

function assertOwnsOrApprover(actor: Actor, employeeUserId: string) {
  if (actor.userId !== employeeUserId && !isApprover(actor)) {
    throw new ExpenseClaimForbiddenError();
  }
}

async function assertAccountUsable(tx: TenantDb, organizationId: string, accountId: string, label: string) {
  const [row] = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.id, accountId)));
  if (!row) throw new InvalidExpenseClaimLineError(`${label} ${accountId} does not exist in this organization.`);
  if (!row.isActive) throw new InvalidExpenseClaimLineError(`${label} ${accountId} is inactive.`);
}

async function loadTaxCodes(tx: TenantDb, organizationId: string, taxCodeIds: string[]) {
  const uniqueIds = [...new Set(taxCodeIds)];
  if (uniqueIds.length === 0)
    return new Map<string, { rate: string; receivableAccountId: string | null; code: string }>();
  const rows = await tx
    .select({ id: taxCodes.id, rate: taxCodes.rate, receivableAccountId: taxCodes.receivableAccountId, code: taxCodes.code })
    .from(taxCodes)
    .where(and(eq(taxCodes.organizationId, organizationId), inArray(taxCodes.id, uniqueIds)));
  return new Map(rows.map((r) => [r.id, { rate: r.rate, receivableAccountId: r.receivableAccountId, code: r.code }]));
}

async function loadClaimOr404(tx: TenantDb, organizationId: string, claimId: string) {
  const [claim] = await tx
    .select()
    .from(expenseClaims)
    .where(and(eq(expenseClaims.id, claimId), eq(expenseClaims.organizationId, organizationId)));
  if (!claim) throw new ExpenseClaimNotFoundError(claimId);
  return claim;
}

async function persistClaimWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateExpenseClaimInput,
  existingId?: string,
): Promise<{ id: string; claimNumber: string }> {
  await assertAccountUsable(tx, actor.organizationId, input.payableAccountId, "Payable account");
  for (const line of input.lines) {
    await assertAccountUsable(tx, actor.organizationId, line.expenseAccountId, "Expense account");
  }

  const taxCodeIds = input.lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);
  const rateByCode = new Map([...taxCodesById.entries()].map(([id, v]) => [id, v.rate]));

  const totals = calculateExpenseClaimTotals(input.lines, input.currency, rateByCode);

  let claimId: string;
  let claimNumber: string;

  if (existingId) {
    const [updated] = await tx
      .update(expenseClaims)
      .set({
        employeeUserId: input.employeeUserId,
        claimDate: input.claimDate,
        description: input.description,
        currency: input.currency,
        payableAccountId: input.payableAccountId,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(expenseClaims.id, existingId))
      .returning({ id: expenseClaims.id, claimNumber: expenseClaims.claimNumber });
    if (!updated) throw new Error("Failed to update expense claim.");
    claimId = updated.id;
    claimNumber = updated.claimNumber;
    await tx.delete(expenseClaimLines).where(eq(expenseClaimLines.expenseClaimId, existingId));
  } else {
    claimNumber = await nextExpenseClaimNumber(tx, actor.organizationId);
    const [created] = await tx
      .insert(expenseClaims)
      .values({
        organizationId: actor.organizationId,
        employeeUserId: input.employeeUserId,
        claimNumber,
        claimDate: input.claimDate,
        description: input.description,
        currency: input.currency,
        payableAccountId: input.payableAccountId,
        memo: input.memo ?? null,
        status: "DRAFT",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdById: actor.userId,
        updatedById: actor.userId,
      })
      .returning({ id: expenseClaims.id });
    if (!created) throw new Error("Failed to create expense claim.");
    claimId = created.id;
  }

  await tx.insert(expenseClaimLines).values(
    totals.lines.map((line, i) => ({
      organizationId: actor.organizationId,
      expenseClaimId: claimId,
      lineNumber: i + 1,
      description: line.description,
      amount: line.amount,
      expenseAccountId: line.expenseAccountId,
      taxCodeId: line.taxCodeId,
      taxAmount: line.taxAmount,
      category: line.category,
      receiptId: line.receiptId,
    })),
  );

  await AuditService.record(tx, actor, {
    action: existingId ? "expense_claim.updated" : "expense_claim.draft_created",
    entityType: "ExpenseClaim",
    entityId: claimId,
    after: { claimNumber, ...totals },
  });

  return { id: claimId, claimNumber };
}

export const ExpenseClaimService = {
  /** Non-approvers only ever see their own claims; approvers can see everyone's. */
  async list(actor: Actor, opts: { status?: ExpenseClaimStatus; mine?: boolean } = {}) {
    assertPermission(actor, "expense_claim:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(expenseClaims.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(expenseClaims.status, opts.status));
      if (opts.mine || !isApprover(actor)) conditions.push(eq(expenseClaims.employeeUserId, actor.userId));

      return tx
        .select()
        .from(expenseClaims)
        .where(and(...conditions))
        .orderBy(desc(expenseClaims.claimDate), desc(expenseClaims.claimNumber));
    });
  },

  async get(actor: Actor, claimId: string) {
    assertPermission(actor, "expense_claim:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [claim] = await tx
        .select()
        .from(expenseClaims)
        .where(and(eq(expenseClaims.id, claimId), eq(expenseClaims.organizationId, actor.organizationId)));
      if (!claim) return null;
      if (claim.employeeUserId !== actor.userId && !isApprover(actor)) {
        throw new ExpenseClaimForbiddenError();
      }

      const lines = await tx
        .select({ line: expenseClaimLines, account: accounts, taxCode: taxCodes })
        .from(expenseClaimLines)
        .innerJoin(accounts, eq(accounts.id, expenseClaimLines.expenseAccountId))
        .leftJoin(taxCodes, eq(taxCodes.id, expenseClaimLines.taxCodeId))
        .where(eq(expenseClaimLines.expenseClaimId, claimId))
        .orderBy(asc(expenseClaimLines.lineNumber));

      return {
        ...claim,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
      };
    });
  },

  async create(actor: Actor, input: CreateExpenseClaimInput) {
    assertPermission(actor, "expense_claim:manage");
    assertOwnsOrApprover(actor, input.employeeUserId);
    return withTenant(actor.organizationId, (tx) => persistClaimWithLines(tx, actor, input));
  },

  async update(actor: Actor, claimId: string, input: UpdateExpenseClaimInput) {
    assertPermission(actor, "expense_claim:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadClaimOr404(tx, actor.organizationId, claimId);
      assertOwnsOrApprover(actor, existing.employeeUserId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new ExpenseClaimNotEditableError(existing.claimNumber);
      }
      return persistClaimWithLines(tx, actor, input, claimId);
    });
  },

  async deleteDraft(actor: Actor, claimId: string) {
    assertPermission(actor, "expense_claim:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadClaimOr404(tx, actor.organizationId, claimId);
      assertOwnsOrApprover(actor, existing.employeeUserId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new ExpenseClaimNotEditableError(existing.claimNumber);
      }
      await tx.delete(expenseClaims).where(eq(expenseClaims.id, claimId));
      await AuditService.record(tx, actor, {
        action: "expense_claim.draft_deleted",
        entityType: "ExpenseClaim",
        entityId: claimId,
        before: { claimNumber: existing.claimNumber },
      });
    });
  },

  /** DRAFT → SUBMITTED. No ledger effect — just gates approval. */
  async submit(actor: Actor, claimId: string) {
    assertPermission(actor, "expense_claim:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const claim = await loadClaimOr404(tx, actor.organizationId, claimId);
      assertOwnsOrApprover(actor, claim.employeeUserId);
      if (claim.status !== "DRAFT") throw new ExpenseClaimNotDraftError(claim.claimNumber);

      const lines = await tx.select().from(expenseClaimLines).where(eq(expenseClaimLines.expenseClaimId, claimId));
      if (lines.length === 0) {
        throw new InvalidExpenseClaimLineError("An expense claim needs at least one line before it can be submitted.");
      }

      const [updated] = await tx
        .update(expenseClaims)
        .set({ status: "SUBMITTED", submittedAt: new Date(), submittedById: actor.userId, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(expenseClaims.id, claimId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "expense_claim.submitted",
        entityType: "ExpenseClaim",
        entityId: claimId,
        before: { status: "DRAFT" },
        after: { status: "SUBMITTED" },
      });

      return updated;
    });
  },

  /**
   * Approves and posts a submitted claim: debits each line's expense
   * account for its `amount`, debits each tax code's receivable (input tax
   * credit) account for the summed `taxAmount`, and credits the claim's
   * payable control account for the total — all through
   * `PostingService.postJournal`, so this inherits every ledger invariant
   * (balance, period-lock, immutability) for free. Never posts directly to
   * `journal_lines`. Requires `expense_claim:approve` — a distinct
   * permission from `expense_claim:manage` so an employee can never approve
   * their own (or anyone's) claim.
   */
  async approve(actor: Actor, claimId: string) {
    assertPermission(actor, "expense_claim:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const claim = await loadClaimOr404(tx, actor.organizationId, claimId);
      if (claim.status !== "SUBMITTED") throw new ExpenseClaimNotSubmittedError(claim.claimNumber);

      const lines = await tx
        .select()
        .from(expenseClaimLines)
        .where(eq(expenseClaimLines.expenseClaimId, claimId))
        .orderBy(asc(expenseClaimLines.lineNumber));
      if (lines.length === 0) {
        throw new InvalidExpenseClaimLineError("An expense claim needs at least one line before it can be posted.");
      }

      const taxCodeIds = lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
      const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);

      const expenseByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        const running = expenseByAccount.get(line.expenseAccountId) ?? Money.zero(claim.currency);
        expenseByAccount.set(line.expenseAccountId, running.add(Money.of(line.amount, claim.currency)));
      }

      const taxByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        if (!line.taxCodeId) continue;
        const taxAmount = Money.of(line.taxAmount, claim.currency);
        if (taxAmount.isZero()) continue;
        const taxCode = taxCodesById.get(line.taxCodeId);
        if (!taxCode) throw new InvalidExpenseClaimLineError(`Unknown tax code on expense claim line ${line.lineNumber}.`);
        if (!taxCode.receivableAccountId) {
          throw new TaxCodeMissingReceivableAccountForExpenseError(taxCode.code);
        }
        const running = taxByAccount.get(taxCode.receivableAccountId) ?? Money.zero(claim.currency);
        taxByAccount.set(taxCode.receivableAccountId, running.add(taxAmount));
      }

      const total = Money.of(claim.total, claim.currency);

      const journalLines: JournalLineDraft[] = [
        ...[...expenseByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          debit: amount.toString(),
          currency: claim.currency,
        })),
        ...[...taxByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          debit: amount.toString(),
          currency: claim.currency,
        })),
        { accountId: claim.payableAccountId, credit: total.toString(), currency: claim.currency },
      ];

      const posted = await PostingService.postJournal(actor, {
        postingDate: claim.claimDate,
        memo: `Expense claim ${claim.claimNumber}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      const [updated] = await tx
        .update(expenseClaims)
        .set({
          status: "APPROVED",
          journalEntryId: posted.entryId,
          approvedAt: new Date(),
          approvedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(expenseClaims.id, claimId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "expense_claim.approved",
        entityType: "ExpenseClaim",
        entityId: claimId,
        before: { status: "SUBMITTED" },
        after: { status: "APPROVED", journalEntryId: posted.entryId, entryNumber: posted.entryNumber },
      });

      return { ...updated!, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },

  /** SUBMITTED → REJECTED. No ledger effect. */
  async reject(actor: Actor, claimId: string, reason: string) {
    assertPermission(actor, "expense_claim:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const claim = await loadClaimOr404(tx, actor.organizationId, claimId);
      if (claim.status !== "SUBMITTED") throw new ExpenseClaimNotSubmittedError(claim.claimNumber);

      const [updated] = await tx
        .update(expenseClaims)
        .set({
          status: "REJECTED",
          rejectedAt: new Date(),
          rejectedById: actor.userId,
          rejectionReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(expenseClaims.id, claimId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "expense_claim.rejected",
        entityType: "ExpenseClaim",
        entityId: claimId,
        before: { status: "SUBMITTED" },
        after: { status: "REJECTED", reason },
      });

      return updated;
    });
  },

  /**
   * Posts a second journal moving the payable to the paying bank/asset
   * account — kept separate from `approve()` the same way bills/invoices
   * separate posting from payment (`SupplierPaymentAllocationService`).
   */
  async markReimbursed(actor: Actor, claimId: string, input: MarkReimbursedInput) {
    assertPermission(actor, "expense_claim:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const claim = await loadClaimOr404(tx, actor.organizationId, claimId);
      if (claim.status !== "APPROVED") throw new ExpenseClaimNotApprovedError(claim.claimNumber);

      await assertAccountUsable(tx, actor.organizationId, input.reimbursementAccountId, "Reimbursement account");

      const total = Money.of(claim.total, claim.currency);
      const posted = await PostingService.postJournal(actor, {
        postingDate: input.reimbursementDate,
        memo: `Reimbursement of expense claim ${claim.claimNumber}${input.reference ? ` (${input.reference})` : ""}`,
        sourceType: "MANUAL",
        lines: [
          { accountId: claim.payableAccountId, debit: total.toString(), currency: claim.currency },
          { accountId: input.reimbursementAccountId, credit: total.toString(), currency: claim.currency },
        ],
      });

      const [updated] = await tx
        .update(expenseClaims)
        .set({
          status: "REIMBURSED",
          reimbursementJournalEntryId: posted.entryId,
          reimbursementAccountId: input.reimbursementAccountId,
          reimbursedAt: new Date(),
          reimbursedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(expenseClaims.id, claimId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "expense_claim.reimbursed",
        entityType: "ExpenseClaim",
        entityId: claimId,
        before: { status: "APPROVED" },
        after: { status: "REIMBURSED", journalEntryId: posted.entryId, entryNumber: posted.entryNumber },
      });

      return { ...updated!, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },

  /**
   * Corrects an approved-but-not-yet-reimbursed claim by reversing its
   * posting journal — the claim's own amounts are never edited, per
   * docs/accounting-engine.md §1's reversal-only rule. Refuses once the
   * claim has been reimbursed (that would need the reimbursement journal
   * reversed first, which this slice does not implement — see
   * docs/roadmap.md).
   */
  async voidClaim(actor: Actor, claimId: string, reason: string) {
    assertPermission(actor, "expense_claim:approve");
    return withTenant(actor.organizationId, async (tx) => {
      const claim = await loadClaimOr404(tx, actor.organizationId, claimId);
      if (claim.status === "VOID") throw new ExpenseClaimAlreadyVoidError(claim.claimNumber);
      if (claim.status !== "APPROVED" || !claim.journalEntryId) {
        throw new ExpenseClaimNotApprovedError(claim.claimNumber);
      }

      const reversal = await PostingService.reverseEntry(actor, claim.journalEntryId, reason);

      const [updated] = await tx
        .update(expenseClaims)
        .set({
          status: "VOID",
          voidJournalEntryId: reversal.entryId,
          voidedAt: new Date(),
          voidedById: actor.userId,
          voidReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(expenseClaims.id, claimId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "expense_claim.voided",
        entityType: "ExpenseClaim",
        entityId: claimId,
        before: { status: claim.status },
        after: { status: "VOID", reversalEntryId: reversal.entryId, reason },
      });

      return updated;
    });
  },
};
