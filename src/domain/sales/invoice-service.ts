import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  accounts,
  contacts,
  invoiceLines,
  invoices,
  taxCodes,
  type invoiceStatusEnum,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { PostingService } from "@/domain/ledger/posting-service";
import type { JournalLineDraft } from "@/domain/ledger/types";
import {
  InvalidContactForInvoiceError,
  InvalidInvoiceLineError,
  InvoiceAlreadyVoidError,
  InvoiceHasPaymentsError,
  InvoiceNotDraftError,
  InvoiceNotEditableError,
  InvoiceNotFoundError,
  InvoiceNotPostedError,
  TaxCodeMissingPayableAccountError,
} from "./errors";
import { calculateInvoiceTotals } from "./invoice-calculations";
import { nextInvoiceNumber } from "./numbering";
import type { CreateInvoiceInput, InvoiceLineInput, UpdateInvoiceInput } from "./types";
import { paymentAllocations, products, organizations } from "@/db/schema";
import { InventoryService } from "@/domain/inventory/inventory-service";
import { ProductCurrencyMismatchError, VoidWouldDesyncInventoryError } from "@/domain/inventory/errors";

type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];

/** Statuses in which an invoice's header/lines may still be edited or the draft deleted. */
const EDITABLE_STATUSES: InvoiceStatus[] = ["DRAFT"];

async function assertActiveCustomer(tx: TenantDb, organizationId: string, contactId: string) {
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)));
  if (!contact || !contact.isActive || (contact.kind !== "CUSTOMER" && contact.kind !== "BOTH")) {
    throw new InvalidContactForInvoiceError(contactId);
  }
  return contact;
}

async function assertAccountsUsable(tx: TenantDb, organizationId: string, accountIds: string[]) {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.length === 0) return;
  const rows = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, uniqueIds)));
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of uniqueIds) {
    const row = found.get(id);
    if (!row) throw new InvalidInvoiceLineError(`Account ${id} does not exist in this organization.`);
    if (!row.isActive) throw new InvalidInvoiceLineError(`Account ${id} is inactive.`);
  }
}

/** Loads {rate, payableAccountId} for a set of tax code ids, scoped to the org. */
async function loadTaxCodes(tx: TenantDb, organizationId: string, taxCodeIds: string[]) {
  const uniqueIds = [...new Set(taxCodeIds)];
  if (uniqueIds.length === 0) return new Map<string, { rate: string; payableAccountId: string | null; code: string }>();
  const rows = await tx
    .select({ id: taxCodes.id, rate: taxCodes.rate, payableAccountId: taxCodes.payableAccountId, code: taxCodes.code })
    .from(taxCodes)
    .where(and(eq(taxCodes.organizationId, organizationId), inArray(taxCodes.id, uniqueIds)));
  return new Map(rows.map((r) => [r.id, { rate: r.rate, payableAccountId: r.payableAccountId, code: r.code }]));
}

/**
 * For every line that carries a `productId`, resolves/overwrites its
 * `accountId` from the product's own wiring rather than whatever account
 * the caller passed — see `InvoiceLineInput.productId`'s comment and
 * `products`' doc comment in src/db/schema.ts for exactly which account.
 * A `TRACKED_INVENTORY` product may only be sold in the organization's
 * base currency this slice (no multi-currency inventory costing — see
 * docs/roadmap.md), checked here before any calculation runs.
 */
async function resolveProductLines(
  tx: TenantDb,
  organizationId: string,
  lines: InvoiceLineInput[],
  currency: string,
): Promise<InvoiceLineInput[]> {
  const productIds = [...new Set(lines.map((l) => l.productId).filter((id): id is string => !!id))];
  if (productIds.length === 0) return lines;

  const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId));
  const baseCurrency = org?.baseCurrency ?? currency;

  const rows = await tx
    .select()
    .from(products)
    .where(and(eq(products.organizationId, organizationId), inArray(products.id, productIds)));
  const byId = new Map(rows.map((p) => [p.id, p]));

  return lines.map((line, index) => {
    if (!line.productId) return line;
    const product = byId.get(line.productId);
    if (!product) throw new InvalidInvoiceLineError(`Line ${index + 1}: unknown product.`);
    if (!product.isActive) throw new InvalidInvoiceLineError(`Line ${index + 1}: product ${product.sku} is inactive.`);
    if (product.type === "TRACKED_INVENTORY" && currency !== baseCurrency) {
      throw new ProductCurrencyMismatchError(product.sku, currency, baseCurrency);
    }
    return { ...line, accountId: product.revenueAccountId };
  });
}

async function loadInvoiceOr404(tx: TenantDb, organizationId: string, invoiceId: string) {
  const [invoice] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, organizationId)));
  if (!invoice) throw new InvoiceNotFoundError(invoiceId);
  return invoice;
}

/** Sum of everything ever allocated against this invoice — the source of truth for "outstanding", never a denormalized counter. */
export async function loadAllocatedTotal(tx: TenantDb, organizationId: string, invoiceId: string): Promise<string> {
  const rows = await tx
    .select({ amount: paymentAllocations.amount })
    .from(paymentAllocations)
    .where(and(eq(paymentAllocations.organizationId, organizationId), eq(paymentAllocations.invoiceId, invoiceId)));
  const [invoice] = await tx.select({ currency: invoices.currency }).from(invoices).where(eq(invoices.id, invoiceId));
  const currency = invoice?.currency ?? "AUD";
  return rows.reduce((sum, r) => sum.add(Money.of(r.amount, currency)), Money.zero(currency)).toString();
}

async function persistInvoiceWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateInvoiceInput,
  existingId?: string,
): Promise<{ id: string; invoiceNumber: string; lines: { id: string; lineNumber: number }[] }> {
  const customer = await assertActiveCustomer(tx, actor.organizationId, input.customerContactId);
  const resolvedLines = await resolveProductLines(tx, actor.organizationId, input.lines, input.currency);
  await assertAccountsUsable(tx, actor.organizationId, [
    input.arAccountId,
    ...resolvedLines.map((l) => l.accountId).filter((id): id is string => !!id),
  ]);

  const taxCodeIds = resolvedLines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);
  const rateByCode = new Map([...taxCodesById.entries()].map(([id, v]) => [id, v.rate]));

  const totals = calculateInvoiceTotals(resolvedLines, input.currency, rateByCode);

  let invoiceId: string;
  let invoiceNumber: string;

  if (existingId) {
    const [updated] = await tx
      .update(invoices)
      .set({
        customerContactId: input.customerContactId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency: input.currency,
        arAccountId: input.arAccountId,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, existingId))
      .returning({ id: invoices.id, invoiceNumber: invoices.invoiceNumber });
    if (!updated) throw new Error("Failed to update invoice.");
    invoiceId = updated.id;
    invoiceNumber = updated.invoiceNumber;
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, existingId));
  } else {
    invoiceNumber = await nextInvoiceNumber(tx, actor.organizationId);
    const [created] = await tx
      .insert(invoices)
      .values({
        organizationId: actor.organizationId,
        customerContactId: input.customerContactId,
        invoiceNumber,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency: input.currency,
        arAccountId: input.arAccountId,
        memo: input.memo ?? null,
        status: "DRAFT",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdById: actor.userId,
        updatedById: actor.userId,
      })
      .returning({ id: invoices.id });
    if (!created) throw new Error("Failed to create invoice.");
    invoiceId = created.id;
  }

  const insertedLines = await tx
    .insert(invoiceLines)
    .values(
      totals.lines.map((line, i) => ({
        organizationId: actor.organizationId,
        invoiceId,
        lineNumber: i + 1,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        accountId: line.accountId,
        taxCodeId: line.taxCodeId,
        projectId: line.projectId,
        taskId: line.taskId,
        productId: line.productId,
        lineAmount: line.lineAmount,
        taxAmount: line.taxAmount,
      })),
    )
    .returning({ id: invoiceLines.id, lineNumber: invoiceLines.lineNumber });

  await AuditService.record(tx, actor, {
    action: existingId ? "invoice.updated" : "invoice.draft_created",
    entityType: "Invoice",
    entityId: invoiceId,
    after: { invoiceNumber, customer: customer.displayName, ...totals },
  });

  return { id: invoiceId, invoiceNumber, lines: insertedLines };
}

export const InvoiceService = {
  async list(actor: Actor, opts: { status?: InvoiceStatus; customerContactId?: string } = {}) {
    assertPermission(actor, "customer_invoice:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(invoices.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(invoices.status, opts.status));
      if (opts.customerContactId) conditions.push(eq(invoices.customerContactId, opts.customerContactId));

      const rows = await tx
        .select({ invoice: invoices, customer: contacts })
        .from(invoices)
        .innerJoin(contacts, eq(contacts.id, invoices.customerContactId))
        .where(and(...conditions))
        .orderBy(desc(invoices.issueDate), desc(invoices.invoiceNumber));

      return Promise.all(
        rows.map(async (row) => {
          const allocated = await loadAllocatedTotal(tx, actor.organizationId, row.invoice.id);
          return { ...row.invoice, customer: row.customer, amountPaid: allocated };
        }),
      );
    });
  },

  async get(actor: Actor, invoiceId: string) {
    assertPermission(actor, "customer_invoice:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ invoice: invoices, customer: contacts })
        .from(invoices)
        .innerJoin(contacts, eq(contacts.id, invoices.customerContactId))
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: invoiceLines, account: accounts, taxCode: taxCodes })
        .from(invoiceLines)
        .innerJoin(accounts, eq(accounts.id, invoiceLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, invoiceLines.taxCodeId))
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .orderBy(asc(invoiceLines.lineNumber));

      const allocations = await tx
        .select()
        .from(paymentAllocations)
        .where(and(eq(paymentAllocations.organizationId, actor.organizationId), eq(paymentAllocations.invoiceId, invoiceId)));

      const amountPaid = await loadAllocatedTotal(tx, actor.organizationId, invoiceId);

      return {
        ...row.invoice,
        customer: row.customer,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
        allocations,
        amountPaid,
      };
    });
  },

  async create(actor: Actor, input: CreateInvoiceInput) {
    assertPermission(actor, "customer_invoice:manage");
    return withTenant(actor.organizationId, (tx) => persistInvoiceWithLines(tx, actor, input));
  },

  async update(actor: Actor, invoiceId: string, input: UpdateInvoiceInput) {
    assertPermission(actor, "customer_invoice:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadInvoiceOr404(tx, actor.organizationId, invoiceId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new InvoiceNotEditableError(existing.invoiceNumber);
      }
      return persistInvoiceWithLines(tx, actor, input, invoiceId);
    });
  },

  async deleteDraft(actor: Actor, invoiceId: string) {
    assertPermission(actor, "customer_invoice:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadInvoiceOr404(tx, actor.organizationId, invoiceId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new InvoiceNotEditableError(existing.invoiceNumber);
      }
      await tx.delete(invoices).where(eq(invoices.id, invoiceId));
      await AuditService.record(tx, actor, {
        action: "invoice.draft_deleted",
        entityType: "Invoice",
        entityId: invoiceId,
        before: { invoiceNumber: existing.invoiceNumber },
      });
    });
  },

  /**
   * Approves and posts a draft invoice: debits the invoice's AR control
   * account for the total, credits each line's revenue account for its
   * `lineAmount`, and credits each tax code's payable account for the
   * summed `taxAmount` — all through `PostingService.postJournal`, so this
   * inherits every ledger invariant (balance, period-lock, immutability)
   * for free rather than re-implementing any of them. Never posts directly
   * to `journal_lines`.
   */
  async approveAndPost(actor: Actor, invoiceId: string) {
    assertPermission(actor, "customer_invoice:post");
    return withTenant(actor.organizationId, async (tx) => {
      const invoice = await loadInvoiceOr404(tx, actor.organizationId, invoiceId);
      if (invoice.status !== "DRAFT") {
        throw new InvoiceNotDraftError(invoice.invoiceNumber);
      }

      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .orderBy(asc(invoiceLines.lineNumber));
      if (lines.length === 0) {
        throw new InvalidInvoiceLineError("An invoice needs at least one line before it can be posted.");
      }

      const taxCodeIds = lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
      const taxCodesById = await loadTaxCodes(tx, actor.organizationId, taxCodeIds);

      // Credit revenue accounts, one line per distinct account (a multi-line
      // invoice hitting the same revenue account collapses into one credit).
      const revenueByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        const running = revenueByAccount.get(line.accountId) ?? Money.zero(invoice.currency);
        revenueByAccount.set(line.accountId, running.add(Money.of(line.lineAmount, invoice.currency)));
      }

      // Credit tax payable accounts, one line per distinct tax code's account.
      const taxByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      for (const line of lines) {
        if (!line.taxCodeId) continue;
        const taxAmount = Money.of(line.taxAmount, invoice.currency);
        if (taxAmount.isZero()) continue;
        const taxCode = taxCodesById.get(line.taxCodeId);
        if (!taxCode) throw new InvalidInvoiceLineError(`Unknown tax code on invoice line ${line.lineNumber}.`);
        if (!taxCode.payableAccountId) {
          throw new TaxCodeMissingPayableAccountError(taxCode.code);
        }
        const running = taxByAccount.get(taxCode.payableAccountId) ?? Money.zero(invoice.currency);
        taxByAccount.set(taxCode.payableAccountId, running.add(taxAmount));
      }

      const total = Money.of(invoice.total, invoice.currency);

      // Phase 7 Slice 2 (Inventory): every line selling a TRACKED_INVENTORY
      // product also records a SALE movement — decreasing quantity and
      // computing COGS at the then-current weighted-average cost — and
      // that COGS debit/inventory-asset credit is added to this SAME
      // journal entry, posted alongside (not after, not in a separate
      // process) the sale's own revenue/tax lines. Oversell is rejected by
      // InventoryService.recordSale (InsufficientStockError), which aborts
      // this whole transaction before anything is posted.
      const cogsByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      const inventoryAssetByAccount = new Map<string, ReturnType<typeof Money.zero>>();
      const movementIds: string[] = [];
      for (const line of lines) {
        if (!line.productId) continue;
        const [product] = await tx.select().from(products).where(eq(products.id, line.productId));
        if (!product || product.type !== "TRACKED_INVENTORY") continue;

        const sale = await InventoryService.recordSale(tx, actor, {
          productId: line.productId,
          quantity: line.quantity,
          invoiceLineId: line.id,
          occurredAt: invoice.issueDate,
        });
        movementIds.push(sale.movementId);

        const cogsAmount = Money.of(sale.cogsAmount, invoice.currency);
        cogsByAccount.set(sale.cogsAccountId, (cogsByAccount.get(sale.cogsAccountId) ?? Money.zero(invoice.currency)).add(cogsAmount));
        inventoryAssetByAccount.set(
          sale.inventoryAssetAccountId,
          (inventoryAssetByAccount.get(sale.inventoryAssetAccountId) ?? Money.zero(invoice.currency)).add(cogsAmount),
        );
      }

      const journalLines: JournalLineDraft[] = [
        { accountId: invoice.arAccountId, debit: total.toString(), currency: invoice.currency },
        ...[...revenueByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          credit: amount.toString(),
          currency: invoice.currency,
          contactId: invoice.customerContactId,
        })),
        ...[...taxByAccount.entries()].map(([accountId, amount]) => ({
          accountId,
          credit: amount.toString(),
          currency: invoice.currency,
        })),
        ...[...cogsByAccount.entries()]
          .filter(([, amount]) => !amount.isZero())
          .map(([accountId, amount]) => ({ accountId, debit: amount.toString(), currency: invoice.currency })),
        ...[...inventoryAssetByAccount.entries()]
          .filter(([, amount]) => !amount.isZero())
          .map(([accountId, amount]) => ({ accountId, credit: amount.toString(), currency: invoice.currency })),
      ];

      const posted = await PostingService.postJournal(actor, {
        postingDate: invoice.issueDate,
        memo: `Invoice ${invoice.invoiceNumber}`,
        sourceType: "MANUAL",
        lines: journalLines,
      });

      if (movementIds.length > 0) {
        await InventoryService.linkMovementsToJournalEntry(tx, movementIds, posted.entryId);
      }

      const [updated] = await tx
        .update(invoices)
        .set({
          status: "APPROVED",
          journalEntryId: posted.entryId,
          postedAt: new Date(),
          postedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoiceId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "invoice.posted",
        entityType: "Invoice",
        entityId: invoiceId,
        before: { status: "DRAFT" },
        after: { status: "APPROVED", journalEntryId: posted.entryId, entryNumber: posted.entryNumber },
      });

      return { ...updated!, journalEntryId: posted.entryId, entryNumber: posted.entryNumber };
    });
  },

  /**
   * "Sent"/"viewed" only advance the status while it's still purely
   * informational (APPROVED, or already SENT so this is idempotent) — once
   * a payment has been allocated, `status` reflects payment progress
   * (PART_PAID/PAID) instead, and delivery tracking is a no-op rather than
   * overwriting that with a step backwards.
   */
  async markSent(actor: Actor, invoiceId: string) {
    assertPermission(actor, "customer_invoice:manage");
    return setInformationalStatus(actor, invoiceId, "SENT", ["APPROVED", "SENT"]);
  },

  async markViewed(actor: Actor, invoiceId: string) {
    assertPermission(actor, "customer_invoice:manage");
    return setInformationalStatus(actor, invoiceId, "VIEWED", ["APPROVED", "SENT", "VIEWED"]);
  },

  /**
   * Corrects a posted invoice by reversing its posting journal — the
   * invoice's own amounts are never edited, per docs/accounting-engine.md
   * §1's reversal-only rule. Refuses while any payment is still allocated,
   * so the fix is always "unallocate, then void", never "void out from
   * under an allocation".
   */
  async voidInvoice(actor: Actor, invoiceId: string, reason: string) {
    assertPermission(actor, "customer_invoice:void");
    return withTenant(actor.organizationId, async (tx) => {
      const invoice = await loadInvoiceOr404(tx, actor.organizationId, invoiceId);
      if (invoice.status === "VOID") throw new InvoiceAlreadyVoidError(invoice.invoiceNumber);
      if (invoice.status === "DRAFT" || !invoice.journalEntryId) {
        throw new InvoiceNotPostedError(invoice.invoiceNumber);
      }

      const allocated = await loadAllocatedTotal(tx, actor.organizationId, invoiceId);
      if (!Money.of(allocated, invoice.currency).isZero()) {
        throw new InvoiceHasPaymentsError(invoice.invoiceNumber);
      }

      // Phase 7 Slice 2 (Inventory): voiding an invoice with a
      // TRACKED_INVENTORY line is refused — see VoidWouldDesyncInventoryError's
      // doc comment for why reversing stock/weighted-average history is
      // deferred rather than done incorrectly.
      const linesWithProducts = await tx
        .select({ productId: invoiceLines.productId })
        .from(invoiceLines)
        .where(and(eq(invoiceLines.invoiceId, invoiceId), isNotNull(invoiceLines.productId)));
      if (linesWithProducts.length > 0) {
        const productIds = linesWithProducts.map((l) => l.productId!);
        const trackedRows = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(inArray(products.id, productIds), eq(products.type, "TRACKED_INVENTORY")));
        if (trackedRows.length > 0) {
          throw new VoidWouldDesyncInventoryError(invoice.invoiceNumber);
        }
      }

      const reversal = await PostingService.reverseEntry(actor, invoice.journalEntryId, reason);

      const [updated] = await tx
        .update(invoices)
        .set({
          status: "VOID",
          voidJournalEntryId: reversal.entryId,
          voidedAt: new Date(),
          voidedById: actor.userId,
          voidReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, invoiceId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "invoice.voided",
        entityType: "Invoice",
        entityId: invoiceId,
        before: { status: invoice.status },
        after: { status: "VOID", reversalEntryId: reversal.entryId, reason },
      });

      return updated;
    });
  },
};

async function setInformationalStatus(
  actor: Actor,
  invoiceId: string,
  status: "SENT" | "VIEWED",
  allowedFrom: InvoiceStatus[],
) {
  return withTenant(actor.organizationId, async (tx) => {
    const invoice = await loadInvoiceOr404(tx, actor.organizationId, invoiceId);
    if (!allowedFrom.includes(invoice.status)) return invoice;

    const [updated] = await tx
      .update(invoices)
      .set({ status, updatedById: actor.userId, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId))
      .returning();

    await AuditService.record(tx, actor, {
      action: status === "SENT" ? "invoice.sent" : "invoice.viewed",
      entityType: "Invoice",
      entityId: invoiceId,
      before: { status: invoice.status },
      after: { status },
    });

    return updated;
  });
}
