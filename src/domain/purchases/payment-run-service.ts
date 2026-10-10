import { and, desc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  bills,
  contacts,
  organizationMemberships,
  paymentRunItems,
  paymentRuns,
  type paymentRunStatusEnum,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { AuditService } from "@/domain/audit/audit-service";
import { SupplierPaymentAllocationService } from "./supplier-payment-service";
import { loadAllocatedTotal } from "./bill-service";
import {
  BillNotEligibleForPaymentRunError,
  InvalidBillLineError,
  PaymentRunCurrencyMismatchError,
  PaymentRunEmptyError,
  PaymentRunNotAwaitingApprovalError,
  PaymentRunNotEditableError,
  PaymentRunNotFoundError,
  SelfApprovalNotAllowedError,
} from "./errors";
import { nextPaymentRunNumber } from "./numbering";
import type { CreatePaymentRunInput } from "./types";

type RunStatus = (typeof paymentRunStatusEnum.enumValues)[number];

const BILL_ELIGIBLE_STATUSES = new Set(["APPROVED", "PART_PAID"]);

async function loadRunOr404(tx: TenantDb, organizationId: string, runId: string) {
  const [run] = await tx.select().from(paymentRuns).where(and(eq(paymentRuns.id, runId), eq(paymentRuns.organizationId, organizationId)));
  if (!run) throw new PaymentRunNotFoundError(runId);
  return run;
}

async function loadItems(tx: TenantDb, runId: string) {
  return tx
    .select({ item: paymentRunItems, bill: bills, supplier: contacts })
    .from(paymentRunItems)
    .innerJoin(bills, eq(bills.id, paymentRunItems.billId))
    .innerJoin(contacts, eq(contacts.id, bills.supplierContactId))
    .where(eq(paymentRunItems.paymentRunId, runId));
}

/**
 * Counts how many *distinct, active* organization members hold
 * `payment_run:approve` — used only to decide whether the
 * self-approval block below can be safely enforced. See
 * `SelfApprovalNotAllowedError` and docs/roadmap.md for why a
 * one-eligible-approver organization is let through rather than being
 * permanently unable to ever approve a payment run.
 */
async function countEligibleApprovers(tx: TenantDb, organizationId: string): Promise<number> {
  const memberships = await tx
    .select({ role: organizationMemberships.role })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.isActive, true)));
  return memberships.filter((m) => roleHasPermission(m.role, "payment_run:approve")).length;
}

async function recomputeTotal(tx: TenantDb, actor: Actor, runId: string, currency: string) {
  const items = await tx.select({ amount: paymentRunItems.amount }).from(paymentRunItems).where(eq(paymentRunItems.paymentRunId, runId));
  const total = items.reduce((sum, i) => sum.add(Money.of(i.amount, currency)), Money.zero(currency));
  await tx.update(paymentRuns).set({ totalAmount: total.toString(), updatedById: actor.userId, updatedAt: new Date() }).where(eq(paymentRuns.id, runId));
  return total;
}

/** Loads a run + its items using an already-open tx — shared by `get` and by any method (`create`, `removeBill`) that needs to return the full run without nesting a second `withTenant` transaction inside its own. */
async function loadFullRun(tx: TenantDb, organizationId: string, runId: string) {
  const run = await loadRunOr404(tx, organizationId, runId).catch(() => null);
  if (!run) return null;
  const items = await loadItems(tx, runId);
  return { ...run, items: items.map((i) => ({ ...i.item, bill: i.bill, supplier: i.supplier })) };
}

export const PaymentRunService = {
  async list(actor: Actor, opts: { status?: RunStatus } = {}) {
    assertPermission(actor, "payment_run:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(paymentRuns.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(paymentRuns.status, opts.status));
      return tx.select().from(paymentRuns).where(and(...conditions)).orderBy(desc(paymentRuns.createdAt));
    });
  },

  async get(actor: Actor, runId: string) {
    assertPermission(actor, "payment_run:read");
    return withTenant(actor.organizationId, (tx) => loadFullRun(tx, actor.organizationId, runId));
  },

  /**
   * Creates a DRAFT payment run and adds the given bills to it, each
   * defaulting to its full current outstanding balance. Every bill must be
   * APPROVED/PART_PAID (posted, and not already fully paid/void/draft), and
   * in the run's currency.
   */
  async create(actor: Actor, input: CreatePaymentRunInput) {
    assertPermission(actor, "payment_run:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [paymentAccount] = await tx
        .select({ id: accounts.id, isActive: accounts.isActive })
        .from(accounts)
        .where(and(eq(accounts.id, input.paymentAccountId), eq(accounts.organizationId, actor.organizationId)));
      if (!paymentAccount || !paymentAccount.isActive) {
        throw new InvalidBillLineError(`Account ${input.paymentAccountId} does not exist or is inactive in this organization.`);
      }

      const runNumber = await nextPaymentRunNumber(tx, actor.organizationId);
      const [run] = await tx
        .insert(paymentRuns)
        .values({
          organizationId: actor.organizationId,
          runNumber,
          status: "DRAFT",
          paymentDate: input.paymentDate,
          currency: input.currency,
          paymentAccountId: input.paymentAccountId,
          memo: input.memo ?? null,
          totalAmount: "0",
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!run) throw new Error("Failed to create payment run.");

      if (input.billIds.length > 0) {
        const billRows = await tx
          .select()
          .from(bills)
          .where(and(eq(bills.organizationId, actor.organizationId), inArray(bills.id, input.billIds)));
        const billsById = new Map(billRows.map((b) => [b.id, b]));

        for (const billId of input.billIds) {
          const bill = billsById.get(billId);
          if (!bill) throw new InvalidBillLineError(`Bill ${billId} was not found in this organization.`);
          if (!BILL_ELIGIBLE_STATUSES.has(bill.status)) throw new BillNotEligibleForPaymentRunError(bill.billNumber);
          if (bill.currency !== input.currency) throw new PaymentRunCurrencyMismatchError(bill.billNumber);

          const allocated = Money.of(await loadAllocatedTotal(tx, actor.organizationId, bill.id), bill.currency);
          const outstanding = Money.of(bill.total, bill.currency).subtract(allocated);
          if (!outstanding.isPositive()) throw new BillNotEligibleForPaymentRunError(bill.billNumber);

          await tx.insert(paymentRunItems).values({
            organizationId: actor.organizationId,
            paymentRunId: run.id,
            billId: bill.id,
            amount: outstanding.toString(),
          });
        }

        await recomputeTotal(tx, actor, run.id, input.currency);
      }

      await AuditService.record(tx, actor, {
        action: "payment_run.created",
        entityType: "PaymentRun",
        entityId: run.id,
        after: { runNumber, billCount: input.billIds.length },
      });

      return loadFullRun(tx, actor.organizationId, run.id);
    });
  },

  /** Removes a bill from a DRAFT run. */
  async removeBill(actor: Actor, runId: string, billId: string) {
    assertPermission(actor, "payment_run:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadRunOr404(tx, actor.organizationId, runId);
      if (run.status !== "DRAFT") throw new PaymentRunNotEditableError(run.runNumber);
      await tx.delete(paymentRunItems).where(and(eq(paymentRunItems.paymentRunId, runId), eq(paymentRunItems.billId, billId)));
      await recomputeTotal(tx, actor, runId, run.currency);
      await AuditService.record(tx, actor, {
        action: "payment_run.bill_removed",
        entityType: "PaymentRun",
        entityId: runId,
        before: { billId },
      });
      return loadFullRun(tx, actor.organizationId, runId);
    });
  },

  async deleteDraft(actor: Actor, runId: string) {
    assertPermission(actor, "payment_run:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const run = await loadRunOr404(tx, actor.organizationId, runId);
      if (run.status !== "DRAFT") throw new PaymentRunNotEditableError(run.runNumber);
      await tx.delete(paymentRuns).where(eq(paymentRuns.id, runId));
      await AuditService.record(tx, actor, {
        action: "payment_run.draft_deleted",
        entityType: "PaymentRun",
        entityId: runId,
        before: { runNumber: run.runNumber },
      });
    });
  },

  /** DRAFT -> AWAITING_APPROVAL. The run's own creator prepares it up to here; a different user must approve it. */
  async submitForApproval(actor: Actor, runId: string) {
    assertPermission(actor, "payment_run:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadRunOr404(tx, actor.organizationId, runId);
      if (run.status !== "DRAFT") throw new PaymentRunNotEditableError(run.runNumber);

      const items = await loadItems(tx, runId);
      if (items.length === 0) throw new PaymentRunEmptyError();

      const [updated] = await tx
        .update(paymentRuns)
        .set({ status: "AWAITING_APPROVAL", submittedAt: new Date(), submittedById: actor.userId, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(paymentRuns.id, runId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "payment_run.submitted_for_approval",
        entityType: "PaymentRun",
        entityId: runId,
        before: { status: "DRAFT" },
        after: { status: "AWAITING_APPROVAL" },
      });

      return updated;
    });
  },

  /**
   * Approves an AWAITING_APPROVAL run and, in the same step, generates the
   * real underlying `supplier_payments` — one per distinct supplier in the
   * run, via `SupplierPaymentAllocationService.recordPayment` (never a
   * shortcut around it, so this inherits all of that service's own
   * invariants and posts through `PostingService` exactly like a manual
   * payment). This slice has no real bank-file/payment-rail integration
   * (see docs/roadmap.md), so "approved" and "paid" happen together: the
   * financial effect is recording the payment in the ledger, batched and
   * approval-gated, not an actual bank transfer.
   *
   * Segregation of duties (master spec §52) is enforced here, in the
   * service layer: `approvedById` (this call's actor) must differ from
   * `createdById` (whoever prepared the run), or this throws
   * `SelfApprovalNotAllowedError` — UNLESS the organization has only one
   * member holding `payment_run:approve` at all, in which case self-approval
   * is the least-bad option (see docs/roadmap.md for why: otherwise a
   * one-person/two-person organization could never approve any payment run,
   * which is worse than a documented, audited exception).
   */
  async approve(actor: Actor, runId: string) {
    assertPermission(actor, "payment_run:approve");

    // Step 1 — validate and build the payment plan inside one read-only
    // tenant-scoped transaction. `SupplierPaymentAllocationService.recordPayment`
    // (step 2) opens its own top-level transaction, exactly like
    // `QuoteService.convertToInvoice` calls `InvoiceService.create` outside
    // its own transaction rather than nesting `withTenant` inside
    // `withTenant` — a real nested `db.transaction` would grab a second,
    // independent connection/transaction from the pool instead of joining
    // the outer one, silently breaking atomicity.
    const { run, bySupplier, selfApprovalDocumented } = await withTenant(actor.organizationId, async (tx) => {
      const run = await loadRunOr404(tx, actor.organizationId, runId);
      if (run.status !== "AWAITING_APPROVAL") throw new PaymentRunNotAwaitingApprovalError(run.runNumber);

      let selfApprovalDocumented = false;
      if (actor.userId === run.createdById) {
        const eligibleApprovers = await countEligibleApprovers(tx, actor.organizationId);
        if (eligibleApprovers > 1) {
          throw new SelfApprovalNotAllowedError(run.runNumber);
        }
        // Exactly one eligible approver in the whole organization (or the
        // creator's role no longer grants approval but they're still the
        // only one on record) — document the limitation in the audit trail
        // rather than block the organization from ever paying anything.
        selfApprovalDocumented = true;
      }

      const items = await loadItems(tx, runId);
      if (items.length === 0) throw new PaymentRunEmptyError();

      // Re-validate every item's amount against the bill's *current*
      // outstanding balance — never trust what was captured when the bill
      // was added to the run, since time has passed and another payment or
      // credit could have moved it since.
      const bySupplier = new Map<string, { supplierContactId: string; allocations: { billId: string; amount: string }[] }>();
      for (const row of items) {
        const bill = row.bill;
        if (!BILL_ELIGIBLE_STATUSES.has(bill.status)) throw new BillNotEligibleForPaymentRunError(bill.billNumber);
        const allocated = Money.of(await loadAllocatedTotal(tx, actor.organizationId, bill.id), bill.currency);
        const outstanding = Money.of(bill.total, bill.currency).subtract(allocated);
        const amount = Money.of(row.item.amount, run.currency);
        const cappedAmount = amount.compareTo(outstanding) > 0 ? outstanding : amount;
        if (!cappedAmount.isPositive()) continue; // Already fully settled by something else since this run was assembled — skip it silently rather than fail the whole run.

        const key = bill.supplierContactId;
        const group = bySupplier.get(key) ?? { supplierContactId: key, allocations: [] };
        group.allocations.push({ billId: bill.id, amount: cappedAmount.toString() });
        bySupplier.set(key, group);
      }

      return { run, bySupplier, selfApprovalDocumented };
    });

    // Step 2 — generate the real payments, outside any transaction of our
    // own, one per distinct supplier.
    const generatedPayments: Array<{ supplierContactId: string; paymentId: string; allocations: { billId: string; amount: string }[] }> = [];
    for (const group of bySupplier.values()) {
      const groupTotal = group.allocations.reduce((sum, a) => sum.add(Money.of(a.amount, run.currency)), Money.zero(run.currency));
      const payment = await SupplierPaymentAllocationService.recordPayment(actor, {
        supplierContactId: group.supplierContactId,
        paymentDate: run.paymentDate,
        amount: groupTotal.toString(),
        currency: run.currency,
        method: "BANK_TRANSFER",
        paymentAccountId: run.paymentAccountId,
        reference: run.runNumber,
        allocations: group.allocations,
      });
      generatedPayments.push({ supplierContactId: group.supplierContactId, paymentId: payment.id, allocations: group.allocations });
    }

    // Step 3 — record the results and flip the run to PAID in a final
    // tenant-scoped transaction.
    return withTenant(actor.organizationId, async (tx) => {
      for (const payment of generatedPayments) {
        for (const allocation of payment.allocations) {
          await tx
            .update(paymentRunItems)
            .set({ supplierPaymentId: payment.paymentId })
            .where(and(eq(paymentRunItems.paymentRunId, runId), eq(paymentRunItems.billId, allocation.billId)));
        }
      }

      const [updated] = await tx
        .update(paymentRuns)
        .set({
          status: "PAID",
          approvedAt: new Date(),
          approvedById: actor.userId,
          paidAt: new Date(),
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(paymentRuns.id, runId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "payment_run.approved_and_paid",
        entityType: "PaymentRun",
        entityId: runId,
        before: { status: "AWAITING_APPROVAL" },
        after: {
          status: "PAID",
          approvedById: actor.userId,
          createdById: run.createdById,
          selfApprovalDocumented,
          generatedPayments: generatedPayments.map((p) => ({ supplierContactId: p.supplierContactId, paymentId: p.paymentId })),
        },
      });

      return updated;
    });
  },

  async cancel(actor: Actor, runId: string, reason: string) {
    assertPermission(actor, "payment_run:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const run = await loadRunOr404(tx, actor.organizationId, runId);
      if (run.status === "PAID") throw new PaymentRunNotEditableError(run.runNumber);

      const [updated] = await tx
        .update(paymentRuns)
        .set({ status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor.userId, cancelReason: reason, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(paymentRuns.id, runId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "payment_run.cancelled",
        entityType: "PaymentRun",
        entityId: runId,
        before: { status: run.status },
        after: { status: "CANCELLED", reason },
      });

      return updated;
    });
  },
};
