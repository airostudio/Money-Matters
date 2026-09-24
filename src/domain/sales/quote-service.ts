import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { accounts, contacts, quoteLines, quotes, taxCodes, type quoteStatusEnum } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import {
  InvalidContactForInvoiceError,
  InvalidInvoiceLineError,
  QuoteAlreadyConvertedError,
  QuoteNotAcceptedError,
  QuoteNotEditableError,
  QuoteNotFoundError,
  QuoteNotSentError,
} from "./errors";
import { calculateInvoiceTotals } from "./invoice-calculations";
import { nextQuoteNumber } from "./numbering";
import { InvoiceService } from "./invoice-service";
import type { CreateQuoteInput, UpdateQuoteInput } from "./types";

type QuoteStatus = (typeof quoteStatusEnum.enumValues)[number];

/** Statuses in which a quote's header/lines may still be edited or the draft deleted. */
const EDITABLE_STATUSES: QuoteStatus[] = ["DRAFT"];

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

async function loadTaxRates(tx: TenantDb, organizationId: string, taxCodeIds: string[]) {
  const uniqueIds = [...new Set(taxCodeIds)];
  if (uniqueIds.length === 0) return new Map<string, string>();
  const rows = await tx
    .select({ id: taxCodes.id, rate: taxCodes.rate })
    .from(taxCodes)
    .where(and(eq(taxCodes.organizationId, organizationId), inArray(taxCodes.id, uniqueIds)));
  return new Map(rows.map((r) => [r.id, r.rate]));
}

async function loadQuoteOr404(tx: TenantDb, organizationId: string, quoteId: string) {
  const [quote] = await tx
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, organizationId)));
  if (!quote) throw new QuoteNotFoundError(quoteId);
  return quote;
}

async function persistQuoteWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateQuoteInput,
  existingId?: string,
): Promise<{ id: string; quoteNumber: string }> {
  const customer = await assertActiveCustomer(tx, actor.organizationId, input.customerContactId);
  await assertAccountsUsable(tx, actor.organizationId, input.lines.map((l) => l.accountId));

  const taxCodeIds = input.lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const rateByCode = await loadTaxRates(tx, actor.organizationId, taxCodeIds);

  // `calculateInvoiceTotals` is reused verbatim — a quote's line/tax/total
  // math is identical to an invoice's, see docs/accounting-engine.md §4.
  const totals = calculateInvoiceTotals(input.lines, input.currency, rateByCode);

  let quoteId: string;
  let quoteNumber: string;

  if (existingId) {
    const [updated] = await tx
      .update(quotes)
      .set({
        customerContactId: input.customerContactId,
        issueDate: input.issueDate,
        expiryDate: input.expiryDate,
        currency: input.currency,
        memo: input.memo ?? null,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(quotes.id, existingId))
      .returning({ id: quotes.id, quoteNumber: quotes.quoteNumber });
    if (!updated) throw new Error("Failed to update quote.");
    quoteId = updated.id;
    quoteNumber = updated.quoteNumber;
    await tx.delete(quoteLines).where(eq(quoteLines.quoteId, existingId));
  } else {
    quoteNumber = await nextQuoteNumber(tx, actor.organizationId);
    const [created] = await tx
      .insert(quotes)
      .values({
        organizationId: actor.organizationId,
        customerContactId: input.customerContactId,
        quoteNumber,
        issueDate: input.issueDate,
        expiryDate: input.expiryDate,
        currency: input.currency,
        memo: input.memo ?? null,
        status: "DRAFT",
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        createdById: actor.userId,
        updatedById: actor.userId,
      })
      .returning({ id: quotes.id });
    if (!created) throw new Error("Failed to create quote.");
    quoteId = created.id;
  }

  await tx.insert(quoteLines).values(
    totals.lines.map((line, i) => ({
      organizationId: actor.organizationId,
      quoteId,
      lineNumber: i + 1,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxCodeId: line.taxCodeId,
      lineAmount: line.lineAmount,
      taxAmount: line.taxAmount,
    })),
  );

  await AuditService.record(tx, actor, {
    action: existingId ? "quote.updated" : "quote.draft_created",
    entityType: "Quote",
    entityId: quoteId,
    after: { quoteNumber, customer: customer.displayName, ...totals },
  });

  return { id: quoteId, quoteNumber };
}

export const QuoteService = {
  async list(actor: Actor, opts: { status?: QuoteStatus; customerContactId?: string } = {}) {
    assertPermission(actor, "customer_quote:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(quotes.organizationId, actor.organizationId)];
      if (opts.status) conditions.push(eq(quotes.status, opts.status));
      if (opts.customerContactId) conditions.push(eq(quotes.customerContactId, opts.customerContactId));

      const rows = await tx
        .select({ quote: quotes, customer: contacts })
        .from(quotes)
        .innerJoin(contacts, eq(contacts.id, quotes.customerContactId))
        .where(and(...conditions))
        .orderBy(desc(quotes.issueDate), desc(quotes.quoteNumber));

      return rows.map((row) => ({ ...row.quote, customer: row.customer }));
    });
  },

  async get(actor: Actor, quoteId: string) {
    assertPermission(actor, "customer_quote:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ quote: quotes, customer: contacts })
        .from(quotes)
        .innerJoin(contacts, eq(contacts.id, quotes.customerContactId))
        .where(and(eq(quotes.id, quoteId), eq(quotes.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: quoteLines, account: accounts, taxCode: taxCodes })
        .from(quoteLines)
        .innerJoin(accounts, eq(accounts.id, quoteLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, quoteLines.taxCodeId))
        .where(eq(quoteLines.quoteId, quoteId))
        .orderBy(asc(quoteLines.lineNumber));

      return {
        ...row.quote,
        customer: row.customer,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
      };
    });
  },

  async create(actor: Actor, input: CreateQuoteInput) {
    assertPermission(actor, "customer_quote:manage");
    return withTenant(actor.organizationId, (tx) => persistQuoteWithLines(tx, actor, input));
  },

  async update(actor: Actor, quoteId: string, input: UpdateQuoteInput) {
    assertPermission(actor, "customer_quote:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const existing = await loadQuoteOr404(tx, actor.organizationId, quoteId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new QuoteNotEditableError(existing.quoteNumber);
      }
      return persistQuoteWithLines(tx, actor, input, quoteId);
    });
  },

  async deleteDraft(actor: Actor, quoteId: string) {
    assertPermission(actor, "customer_quote:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const existing = await loadQuoteOr404(tx, actor.organizationId, quoteId);
      if (!EDITABLE_STATUSES.includes(existing.status)) {
        throw new QuoteNotEditableError(existing.quoteNumber);
      }
      await tx.delete(quotes).where(eq(quotes.id, quoteId));
      await AuditService.record(tx, actor, {
        action: "quote.draft_deleted",
        entityType: "Quote",
        entityId: quoteId,
        before: { quoteNumber: existing.quoteNumber },
      });
    });
  },

  /** DRAFT -> SENT. Idempotent if already SENT (mirrors `InvoiceService.markSent`). */
  async markSent(actor: Actor, quoteId: string) {
    assertPermission(actor, "customer_quote:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const quote = await loadQuoteOr404(tx, actor.organizationId, quoteId);
      if (quote.status === "SENT") return quote;
      if (quote.status !== "DRAFT") throw new QuoteNotEditableError(quote.quoteNumber);

      const [updated] = await tx
        .update(quotes)
        .set({ status: "SENT", sentAt: new Date(), updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(quotes.id, quoteId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "quote.sent",
        entityType: "Quote",
        entityId: quoteId,
        before: { status: quote.status },
        after: { status: "SENT" },
      });

      return updated;
    });
  },

  /**
   * Records the customer's acceptance. There is no customer portal in this
   * slice (see docs/roadmap.md), so this is always recorded by a human
   * organization member on the customer's behalf — e.g. after a phone call
   * or a signed reply — not a customer-facing action.
   */
  async accept(actor: Actor, quoteId: string) {
    assertPermission(actor, "customer_quote:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const quote = await loadQuoteOr404(tx, actor.organizationId, quoteId);
      if (quote.status !== "SENT") throw new QuoteNotSentError(quote.quoteNumber);

      const [updated] = await tx
        .update(quotes)
        .set({
          status: "ACCEPTED",
          acceptedAt: new Date(),
          acceptedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(quotes.id, quoteId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "quote.accepted",
        entityType: "Quote",
        entityId: quoteId,
        before: { status: quote.status },
        after: { status: "ACCEPTED" },
      });

      return updated;
    });
  },

  async decline(actor: Actor, quoteId: string, reason: string) {
    assertPermission(actor, "customer_quote:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const quote = await loadQuoteOr404(tx, actor.organizationId, quoteId);
      if (quote.status !== "SENT") throw new QuoteNotSentError(quote.quoteNumber);

      const [updated] = await tx
        .update(quotes)
        .set({
          status: "DECLINED",
          declinedAt: new Date(),
          declinedById: actor.userId,
          declineReason: reason,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(quotes.id, quoteId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "quote.declined",
        entityType: "Quote",
        entityId: quoteId,
        before: { status: quote.status },
        after: { status: "DECLINED", reason },
      });

      return updated;
    });
  },

  /**
   * The killer feature: turns an ACCEPTED quote directly into a draft
   * invoice, copying the customer and every line's description/quantity/
   * unit price/account/tax code across — never re-typed. This goes through
   * `InvoiceService.create` exactly like a manually created invoice (same
   * validation, same `calculateInvoiceTotals` call, same audit trail); a
   * quote never posts to the ledger itself, only the invoice it produces
   * does, and only once a human separately approves and posts it.
   */
  async convertToInvoice(
    actor: Actor,
    quoteId: string,
    opts: { issueDate: Date; dueDate: Date; arAccountId: string },
  ) {
    assertPermission(actor, "customer_quote:manage");
    const quote = await withTenant(actor.organizationId, (tx) => loadQuoteOr404(tx, actor.organizationId, quoteId));
    if (quote.status === "CONVERTED") throw new QuoteAlreadyConvertedError(quote.quoteNumber);
    if (quote.status !== "ACCEPTED") throw new QuoteNotAcceptedError(quote.quoteNumber);

    const full = await QuoteService.get(actor, quoteId);
    if (!full) throw new QuoteNotFoundError(quoteId);

    const invoice = await InvoiceService.create(actor, {
      customerContactId: full.customerContactId,
      issueDate: opts.issueDate,
      dueDate: opts.dueDate,
      currency: full.currency,
      arAccountId: opts.arAccountId,
      memo: full.memo ?? `Converted from quote ${full.quoteNumber}`,
      lines: full.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        accountId: l.accountId,
        taxCodeId: l.taxCodeId ?? undefined,
      })),
    });

    return withTenant(actor.organizationId, async (tx) => {
      const [updated] = await tx
        .update(quotes)
        .set({
          status: "CONVERTED",
          convertedInvoiceId: invoice.id,
          convertedAt: new Date(),
          convertedById: actor.userId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(quotes.id, quoteId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "quote.converted_to_invoice",
        entityType: "Quote",
        entityId: quoteId,
        before: { status: "ACCEPTED" },
        after: { status: "CONVERTED", invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
      });

      return { ...updated!, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber };
    });
  },
};
