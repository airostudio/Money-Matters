import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  contacts,
  invoiceRecurringSource,
  recurringInvoiceTemplateLines,
  recurringInvoiceTemplates,
  taxCodes,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import {
  InvalidContactForInvoiceError,
  InvalidInvoiceLineError,
  InvalidRecurringTemplateError,
  RecurringTemplateNotFoundError,
} from "./errors";
import { calculateInvoiceTotals } from "./invoice-calculations";
import { InvoiceService } from "./invoice-service";
import { advanceRecurringDate } from "./recurring-schedule";
import type { CreateRecurringInvoiceTemplateInput, UpdateRecurringInvoiceTemplateInput } from "./types";

/** Default payment terms for a generated invoice — the same default the "New invoice" UI offers. */
const DEFAULT_DUE_DAYS = 30;

/** Hard ceiling on occurrences generated for one template in one `generateDue` call, so a badly configured template (e.g. a start date years in the past) can't run away. */
const MAX_OCCURRENCES_PER_RUN = 366;

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

function validateSchedule(input: CreateRecurringInvoiceTemplateInput) {
  if (!input.name.trim()) {
    throw new InvalidRecurringTemplateError("A recurring invoice template needs a name.");
  }
  if (input.endDate && input.endDate.getTime() < input.startDate.getTime()) {
    throw new InvalidRecurringTemplateError("End date cannot be before the start date.");
  }
  if (input.maxOccurrences !== undefined && input.maxOccurrences <= 0) {
    throw new InvalidRecurringTemplateError("Maximum occurrences must be greater than zero.");
  }
}

async function loadTemplateOr404(tx: TenantDb, organizationId: string, templateId: string) {
  const [template] = await tx
    .select()
    .from(recurringInvoiceTemplates)
    .where(and(eq(recurringInvoiceTemplates.id, templateId), eq(recurringInvoiceTemplates.organizationId, organizationId)));
  if (!template) throw new RecurringTemplateNotFoundError(templateId);
  return template;
}

async function persistTemplateWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateRecurringInvoiceTemplateInput,
  existingId?: string,
): Promise<{ id: string }> {
  validateSchedule(input);
  await assertActiveCustomer(tx, actor.organizationId, input.customerContactId);
  await assertAccountsUsable(tx, actor.organizationId, [input.arAccountId, ...input.lines.map((l) => l.accountId)]);

  const taxCodeIds = input.lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const rateByCode = await loadTaxRates(tx, actor.organizationId, taxCodeIds);
  // Validation only — reuses `calculateInvoiceTotals`' line checks (positive
  // quantity, non-negative price, known tax code, etc.). The result itself
  // isn't stored: a template's totals are recomputed fresh from current tax
  // rates every time it generates an invoice, since a template can run for
  // years and tax rates can change (docs/accounting-engine.md §4).
  calculateInvoiceTotals(input.lines, input.currency, rateByCode);

  let templateId: string;

  if (existingId) {
    const [updated] = await tx
      .update(recurringInvoiceTemplates)
      .set({
        customerContactId: input.customerContactId,
        name: input.name.trim(),
        currency: input.currency,
        arAccountId: input.arAccountId,
        memo: input.memo ?? null,
        frequency: input.frequency,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        maxOccurrences: input.maxOccurrences ?? null,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(recurringInvoiceTemplates.id, existingId))
      .returning({ id: recurringInvoiceTemplates.id });
    if (!updated) throw new Error("Failed to update recurring invoice template.");
    templateId = updated.id;
    await tx.delete(recurringInvoiceTemplateLines).where(eq(recurringInvoiceTemplateLines.templateId, existingId));
  } else {
    const [created] = await tx
      .insert(recurringInvoiceTemplates)
      .values({
        organizationId: actor.organizationId,
        customerContactId: input.customerContactId,
        name: input.name.trim(),
        currency: input.currency,
        arAccountId: input.arAccountId,
        memo: input.memo ?? null,
        frequency: input.frequency,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        maxOccurrences: input.maxOccurrences ?? null,
        occurrencesGenerated: 0,
        nextRunDate: input.startDate,
        isActive: true,
        createdById: actor.userId,
        updatedById: actor.userId,
      })
      .returning({ id: recurringInvoiceTemplates.id });
    if (!created) throw new Error("Failed to create recurring invoice template.");
    templateId = created.id;
  }

  await tx.insert(recurringInvoiceTemplateLines).values(
    input.lines.map((line, i) => ({
      organizationId: actor.organizationId,
      templateId,
      lineNumber: i + 1,
      description: line.description.trim(),
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      accountId: line.accountId,
      taxCodeId: line.taxCodeId ?? null,
    })),
  );

  await AuditService.record(tx, actor, {
    action: existingId ? "recurring_invoice_template.updated" : "recurring_invoice_template.created",
    entityType: "RecurringInvoiceTemplate",
    entityId: templateId,
    after: { name: input.name, frequency: input.frequency, nextRunDate: input.startDate },
  });

  return { id: templateId };
}

export const RecurringInvoiceService = {
  async list(actor: Actor, opts: { customerContactId?: string; activeOnly?: boolean } = {}) {
    assertPermission(actor, "recurring_invoice:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(recurringInvoiceTemplates.organizationId, actor.organizationId)];
      if (opts.customerContactId) conditions.push(eq(recurringInvoiceTemplates.customerContactId, opts.customerContactId));
      if (opts.activeOnly) conditions.push(eq(recurringInvoiceTemplates.isActive, true));

      const rows = await tx
        .select({ template: recurringInvoiceTemplates, customer: contacts })
        .from(recurringInvoiceTemplates)
        .innerJoin(contacts, eq(contacts.id, recurringInvoiceTemplates.customerContactId))
        .where(and(...conditions))
        .orderBy(asc(recurringInvoiceTemplates.nextRunDate));

      return rows.map((row) => ({ ...row.template, customer: row.customer }));
    });
  },

  async get(actor: Actor, templateId: string) {
    assertPermission(actor, "recurring_invoice:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ template: recurringInvoiceTemplates, customer: contacts })
        .from(recurringInvoiceTemplates)
        .innerJoin(contacts, eq(contacts.id, recurringInvoiceTemplates.customerContactId))
        .where(and(eq(recurringInvoiceTemplates.id, templateId), eq(recurringInvoiceTemplates.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: recurringInvoiceTemplateLines, account: accounts, taxCode: taxCodes })
        .from(recurringInvoiceTemplateLines)
        .innerJoin(accounts, eq(accounts.id, recurringInvoiceTemplateLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, recurringInvoiceTemplateLines.taxCodeId))
        .where(eq(recurringInvoiceTemplateLines.templateId, templateId))
        .orderBy(asc(recurringInvoiceTemplateLines.lineNumber));

      return {
        ...row.template,
        customer: row.customer,
        lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })),
      };
    });
  },

  async create(actor: Actor, input: CreateRecurringInvoiceTemplateInput) {
    assertPermission(actor, "recurring_invoice:manage");
    return withTenant(actor.organizationId, (tx) => persistTemplateWithLines(tx, actor, input));
  },

  async update(actor: Actor, templateId: string, input: UpdateRecurringInvoiceTemplateInput) {
    assertPermission(actor, "recurring_invoice:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await loadTemplateOr404(tx, actor.organizationId, templateId);
      return persistTemplateWithLines(tx, actor, input, templateId);
    });
  },

  async setActive(actor: Actor, templateId: string, isActive: boolean) {
    assertPermission(actor, "recurring_invoice:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const template = await loadTemplateOr404(tx, actor.organizationId, templateId);
      const [updated] = await tx
        .update(recurringInvoiceTemplates)
        .set({ isActive, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(recurringInvoiceTemplates.id, templateId))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "recurring_invoice_template.resumed" : "recurring_invoice_template.paused",
        entityType: "RecurringInvoiceTemplate",
        entityId: templateId,
        before: { isActive: template.isActive },
        after: { isActive },
      });

      return updated;
    });
  },

  async deleteTemplate(actor: Actor, templateId: string) {
    assertPermission(actor, "recurring_invoice:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const template = await loadTemplateOr404(tx, actor.organizationId, templateId);
      if (template.occurrencesGenerated > 0) {
        throw new InvalidRecurringTemplateError(
          `Template "${template.name}" has already generated invoices and cannot be deleted — pause it instead.`,
        );
      }
      await tx.delete(recurringInvoiceTemplates).where(eq(recurringInvoiceTemplates.id, templateId));
      await AuditService.record(tx, actor, {
        action: "recurring_invoice_template.deleted",
        entityType: "RecurringInvoiceTemplate",
        entityId: templateId,
        before: { name: template.name },
      });
    });
  },

  /**
   * The on-demand precursor to real scheduling (see docs/roadmap.md): finds
   * every active template with `nextRunDate <= asOfDate`, generates a normal
   * DRAFT invoice per due occurrence via `InvoiceService.create` (never
   * auto-approved/auto-posted — a human still reviews and posts it), and
   * advances `nextRunDate` past that occurrence in the same step. Running
   * this twice on the same day is a no-op the second time: the first run
   * already advanced every template's `nextRunDate` beyond "today".
   *
   * A template that hasn't been run in a while catches up on every occurrence
   * it missed (bounded by `MAX_OCCURRENCES_PER_RUN`), not just the most
   * recent one — "generate the next due invoice(s)" per docs/roadmap.md.
   */
  async generateDue(actor: Actor, asOfDate: Date = new Date()) {
    assertPermission(actor, "recurring_invoice:manage");

    const templates = await withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(recurringInvoiceTemplates)
        .where(
          and(
            eq(recurringInvoiceTemplates.organizationId, actor.organizationId),
            eq(recurringInvoiceTemplates.isActive, true),
          ),
        ),
    );

    const generated: Array<{ templateId: string; invoiceId: string; invoiceNumber: string; issueDate: Date }> = [];

    for (const template of templates) {
      let nextRunDate = new Date(template.nextRunDate);
      let occurrencesGenerated = template.occurrencesGenerated;
      let iterations = 0;

      while (
        nextRunDate.getTime() <= asOfDate.getTime() &&
        (template.endDate === null || nextRunDate.getTime() <= new Date(template.endDate).getTime()) &&
        (template.maxOccurrences === null || occurrencesGenerated < template.maxOccurrences) &&
        iterations < MAX_OCCURRENCES_PER_RUN
      ) {
        iterations += 1;

        const lines = await withTenant(actor.organizationId, (tx) =>
          tx
            .select()
            .from(recurringInvoiceTemplateLines)
            .where(eq(recurringInvoiceTemplateLines.templateId, template.id))
            .orderBy(asc(recurringInvoiceTemplateLines.lineNumber)),
        );

        const issueDate = nextRunDate;
        const dueDate = new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), issueDate.getUTCDate() + DEFAULT_DUE_DAYS));

        const invoice = await InvoiceService.create(actor, {
          customerContactId: template.customerContactId,
          issueDate,
          dueDate,
          currency: template.currency,
          arAccountId: template.arAccountId,
          memo: template.memo ?? `Generated from recurring template "${template.name}"`,
          lines: lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            accountId: l.accountId,
            taxCodeId: l.taxCodeId ?? undefined,
          })),
        });

        occurrencesGenerated += 1;
        nextRunDate = advanceRecurringDate(nextRunDate, template.frequency);

        const stillDue =
          nextRunDate.getTime() <= asOfDate.getTime() &&
          (template.endDate === null || nextRunDate.getTime() <= new Date(template.endDate).getTime()) &&
          (template.maxOccurrences === null || occurrencesGenerated < template.maxOccurrences);
        const completed =
          (template.maxOccurrences !== null && occurrencesGenerated >= template.maxOccurrences) ||
          (template.endDate !== null && nextRunDate.getTime() > new Date(template.endDate).getTime());

        await withTenant(actor.organizationId, async (tx) => {
          await tx.insert(invoiceRecurringSource).values({
            invoiceId: invoice.id,
            organizationId: actor.organizationId,
            templateId: template.id,
          });

          await tx
            .update(recurringInvoiceTemplates)
            .set({
              nextRunDate,
              occurrencesGenerated,
              isActive: completed ? false : true,
              updatedById: actor.userId,
              updatedAt: new Date(),
            })
            .where(eq(recurringInvoiceTemplates.id, template.id));

          await AuditService.record(tx, actor, {
            action: "recurring_invoice_template.generated_invoice",
            entityType: "RecurringInvoiceTemplate",
            entityId: template.id,
            after: {
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              issueDate: issueDate.toISOString(),
              nextRunDate: nextRunDate.toISOString(),
              occurrencesGenerated,
              completed,
            },
          });
        });

        generated.push({ templateId: template.id, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, issueDate });

        if (!stillDue) break;
      }
    }

    return generated;
  },
};
