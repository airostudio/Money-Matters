import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  accounts,
  billRecurringSource,
  contacts,
  recurringBillTemplateLines,
  recurringBillTemplates,
  taxCodes,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { advanceRecurringDate } from "@/domain/sales/recurring-schedule";
import { InvalidBillLineError, InvalidContactForBillError, InvalidRecurringBillTemplateError, RecurringBillTemplateNotFoundError } from "./errors";
import { calculateBillTotals } from "./bill-calculations";
import { BillService } from "./bill-service";
import type { CreateRecurringBillTemplateInput, UpdateRecurringBillTemplateInput } from "./types";

/** Default payment terms for a generated bill — the same default the "New bill" UI offers. */
const DEFAULT_DUE_DAYS = 30;

/** Hard ceiling on occurrences generated for one template in one `generateDue` call, so a badly configured template (e.g. a start date years in the past) can't run away. */
const MAX_OCCURRENCES_PER_RUN = 366;

async function assertActiveSupplier(tx: TenantDb, organizationId: string, contactId: string) {
  const [contact] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, organizationId)));
  if (!contact || !contact.isActive || (contact.kind !== "SUPPLIER" && contact.kind !== "BOTH")) {
    throw new InvalidContactForBillError(contactId);
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
    if (!row) throw new InvalidBillLineError(`Account ${id} does not exist in this organization.`);
    if (!row.isActive) throw new InvalidBillLineError(`Account ${id} is inactive.`);
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

function validateSchedule(input: CreateRecurringBillTemplateInput) {
  if (!input.name.trim()) {
    throw new InvalidRecurringBillTemplateError("A recurring bill template needs a name.");
  }
  if (input.endDate && input.endDate.getTime() < input.startDate.getTime()) {
    throw new InvalidRecurringBillTemplateError("End date cannot be before the start date.");
  }
  if (input.maxOccurrences !== undefined && input.maxOccurrences <= 0) {
    throw new InvalidRecurringBillTemplateError("Maximum occurrences must be greater than zero.");
  }
}

async function loadTemplateOr404(tx: TenantDb, organizationId: string, templateId: string) {
  const [template] = await tx
    .select()
    .from(recurringBillTemplates)
    .where(and(eq(recurringBillTemplates.id, templateId), eq(recurringBillTemplates.organizationId, organizationId)));
  if (!template) throw new RecurringBillTemplateNotFoundError(templateId);
  return template;
}

async function persistTemplateWithLines(
  tx: TenantDb,
  actor: Actor,
  input: CreateRecurringBillTemplateInput,
  existingId?: string,
): Promise<{ id: string }> {
  validateSchedule(input);
  await assertActiveSupplier(tx, actor.organizationId, input.supplierContactId);
  await assertAccountsUsable(tx, actor.organizationId, [input.apAccountId, ...input.lines.map((l) => l.accountId)]);

  const taxCodeIds = input.lines.map((l) => l.taxCodeId).filter((id): id is string => !!id);
  const rateByCode = await loadTaxRates(tx, actor.organizationId, taxCodeIds);
  // Validation only — see `RecurringInvoiceService`'s identical comment: a
  // template's totals are recomputed fresh every time it generates a bill,
  // never stored, since tax rates can change over the template's lifetime.
  calculateBillTotals(input.lines, input.currency, rateByCode);

  let templateId: string;

  if (existingId) {
    const [updated] = await tx
      .update(recurringBillTemplates)
      .set({
        supplierContactId: input.supplierContactId,
        name: input.name.trim(),
        currency: input.currency,
        apAccountId: input.apAccountId,
        memo: input.memo ?? null,
        frequency: input.frequency,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        maxOccurrences: input.maxOccurrences ?? null,
        updatedById: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(recurringBillTemplates.id, existingId))
      .returning({ id: recurringBillTemplates.id });
    if (!updated) throw new Error("Failed to update recurring bill template.");
    templateId = updated.id;
    await tx.delete(recurringBillTemplateLines).where(eq(recurringBillTemplateLines.templateId, existingId));
  } else {
    const [created] = await tx
      .insert(recurringBillTemplates)
      .values({
        organizationId: actor.organizationId,
        supplierContactId: input.supplierContactId,
        name: input.name.trim(),
        currency: input.currency,
        apAccountId: input.apAccountId,
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
      .returning({ id: recurringBillTemplates.id });
    if (!created) throw new Error("Failed to create recurring bill template.");
    templateId = created.id;
  }

  await tx.insert(recurringBillTemplateLines).values(
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
    action: existingId ? "recurring_bill_template.updated" : "recurring_bill_template.created",
    entityType: "RecurringBillTemplate",
    entityId: templateId,
    after: { name: input.name, frequency: input.frequency, nextRunDate: input.startDate },
  });

  return { id: templateId };
}

export const RecurringBillService = {
  async list(actor: Actor, opts: { supplierContactId?: string; activeOnly?: boolean } = {}) {
    assertPermission(actor, "recurring_bill:read");
    return withTenant(actor.organizationId, async (tx) => {
      const conditions = [eq(recurringBillTemplates.organizationId, actor.organizationId)];
      if (opts.supplierContactId) conditions.push(eq(recurringBillTemplates.supplierContactId, opts.supplierContactId));
      if (opts.activeOnly) conditions.push(eq(recurringBillTemplates.isActive, true));

      const rows = await tx
        .select({ template: recurringBillTemplates, supplier: contacts })
        .from(recurringBillTemplates)
        .innerJoin(contacts, eq(contacts.id, recurringBillTemplates.supplierContactId))
        .where(and(...conditions))
        .orderBy(asc(recurringBillTemplates.nextRunDate));

      return rows.map((row) => ({ ...row.template, supplier: row.supplier }));
    });
  },

  async get(actor: Actor, templateId: string) {
    assertPermission(actor, "recurring_bill:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select({ template: recurringBillTemplates, supplier: contacts })
        .from(recurringBillTemplates)
        .innerJoin(contacts, eq(contacts.id, recurringBillTemplates.supplierContactId))
        .where(and(eq(recurringBillTemplates.id, templateId), eq(recurringBillTemplates.organizationId, actor.organizationId)));
      if (!row) return null;

      const lines = await tx
        .select({ line: recurringBillTemplateLines, account: accounts, taxCode: taxCodes })
        .from(recurringBillTemplateLines)
        .innerJoin(accounts, eq(accounts.id, recurringBillTemplateLines.accountId))
        .leftJoin(taxCodes, eq(taxCodes.id, recurringBillTemplateLines.taxCodeId))
        .where(eq(recurringBillTemplateLines.templateId, templateId))
        .orderBy(asc(recurringBillTemplateLines.lineNumber));

      return { ...row.template, supplier: row.supplier, lines: lines.map((l) => ({ ...l.line, account: l.account, taxCode: l.taxCode })) };
    });
  },

  async create(actor: Actor, input: CreateRecurringBillTemplateInput) {
    assertPermission(actor, "recurring_bill:manage");
    return withTenant(actor.organizationId, (tx) => persistTemplateWithLines(tx, actor, input));
  },

  async update(actor: Actor, templateId: string, input: UpdateRecurringBillTemplateInput) {
    assertPermission(actor, "recurring_bill:manage");
    return withTenant(actor.organizationId, async (tx) => {
      await loadTemplateOr404(tx, actor.organizationId, templateId);
      return persistTemplateWithLines(tx, actor, input, templateId);
    });
  },

  async setActive(actor: Actor, templateId: string, isActive: boolean) {
    assertPermission(actor, "recurring_bill:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const template = await loadTemplateOr404(tx, actor.organizationId, templateId);
      const [updated] = await tx
        .update(recurringBillTemplates)
        .set({ isActive, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(recurringBillTemplates.id, templateId))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "recurring_bill_template.resumed" : "recurring_bill_template.paused",
        entityType: "RecurringBillTemplate",
        entityId: templateId,
        before: { isActive: template.isActive },
        after: { isActive },
      });

      return updated;
    });
  },

  async deleteTemplate(actor: Actor, templateId: string) {
    assertPermission(actor, "recurring_bill:manage");
    await withTenant(actor.organizationId, async (tx) => {
      const template = await loadTemplateOr404(tx, actor.organizationId, templateId);
      if (template.occurrencesGenerated > 0) {
        throw new InvalidRecurringBillTemplateError(
          `Template "${template.name}" has already generated bills and cannot be deleted — pause it instead.`,
        );
      }
      await tx.delete(recurringBillTemplates).where(eq(recurringBillTemplates.id, templateId));
      await AuditService.record(tx, actor, {
        action: "recurring_bill_template.deleted",
        entityType: "RecurringBillTemplate",
        entityId: templateId,
        before: { name: template.name },
      });
    });
  },

  /**
   * The on-demand precursor to real scheduling (see docs/roadmap.md), the
   * purchase-side mirror of `RecurringInvoiceService.generateDue`: finds
   * every active template with `nextRunDate <= asOfDate`, generates a normal
   * DRAFT bill per due occurrence via `BillService.create` (never
   * auto-approved/auto-posted), and advances `nextRunDate` past that
   * occurrence in the same step, so re-running this the same day is a no-op.
   * A template that hasn't run in a while catches up on every missed
   * occurrence (bounded by `MAX_OCCURRENCES_PER_RUN`).
   */
  async generateDue(actor: Actor, asOfDate: Date = new Date()) {
    assertPermission(actor, "recurring_bill:manage");

    const templates = await withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(recurringBillTemplates)
        .where(and(eq(recurringBillTemplates.organizationId, actor.organizationId), eq(recurringBillTemplates.isActive, true))),
    );

    const generated: Array<{ templateId: string; billId: string; billNumber: string; issueDate: Date }> = [];

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
            .from(recurringBillTemplateLines)
            .where(eq(recurringBillTemplateLines.templateId, template.id))
            .orderBy(asc(recurringBillTemplateLines.lineNumber)),
        );

        const issueDate = nextRunDate;
        const dueDate = new Date(Date.UTC(issueDate.getUTCFullYear(), issueDate.getUTCMonth(), issueDate.getUTCDate() + DEFAULT_DUE_DAYS));

        const bill = await BillService.create(actor, {
          supplierContactId: template.supplierContactId,
          issueDate,
          dueDate,
          currency: template.currency,
          apAccountId: template.apAccountId,
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
          await tx.insert(billRecurringSource).values({
            billId: bill.id,
            organizationId: actor.organizationId,
            templateId: template.id,
          });

          await tx
            .update(recurringBillTemplates)
            .set({
              nextRunDate,
              occurrencesGenerated,
              isActive: completed ? false : true,
              updatedById: actor.userId,
              updatedAt: new Date(),
            })
            .where(eq(recurringBillTemplates.id, template.id));

          await AuditService.record(tx, actor, {
            action: "recurring_bill_template.generated_bill",
            entityType: "RecurringBillTemplate",
            entityId: template.id,
            after: {
              billId: bill.id,
              billNumber: bill.billNumber,
              issueDate: issueDate.toISOString(),
              nextRunDate: nextRunDate.toISOString(),
              occurrencesGenerated,
              completed,
            },
          });
        });

        generated.push({ templateId: template.id, billId: bill.id, billNumber: bill.billNumber, issueDate });

        if (!stillDue) break;
      }
    }

    return generated;
  },
};
