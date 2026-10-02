import { and, eq, inArray } from "drizzle-orm";
import { timesheetEntries } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { Money } from "@/domain/money/money";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { InvoiceService } from "@/domain/sales/invoice-service";
import type { InvoiceLineInput } from "@/domain/sales/types";
import { loadProjectOr404 } from "./project-service";
import { queryUnbilledEntries } from "./timesheet-service";
import { NoBillingRateError, NoUnbilledTimeError, ProjectHasNoCustomerError } from "./errors";
import type { CreateInvoiceFromUnbilledTimeInput } from "./types";

/**
 * Master spec §23's explicit integration requirement: approved, billable
 * time flows into a customer invoice "without entering it multiple times."
 * This is the ONLY path from unbilled time to an invoice — it calls
 * `InvoiceService.create` exactly like any other draft invoice (DRAFT,
 * never auto-posted, still requires `InvoiceService.approveAndPost`
 * separately), never a parallel posting path. Double-billing is prevented
 * structurally, not by convention: every selected entry is updated to
 * status INVOICED with `invoiceId`/`invoiceLineId` set as soon as the
 * invoice exists, and `queryUnbilledEntries`'s own `WHERE` clause excludes
 * anything with `invoiceId` already set — so a second call with an
 * overlapping or identical date range can only ever pick up entries this
 * call didn't already claim.
 *
 * Correcting already-invoiced time: once INVOICED, a timesheet entry is
 * immutable (see `timesheet_entry_status`'s schema comment) — the fix is to
 * void the generated invoice (`InvoiceService.voidInvoice`, which reverses
 * its posting journal, never edits it) and log fresh, correct time. Voiding
 * the invoice does NOT automatically revert the entries' status back to
 * APPROVED in this slice — that reversal path (and what it should mean for
 * an invoice that's already been partially paid) is a deliberate scope cut,
 * documented in docs/roadmap.md, rather than a half-built auto-revert that
 * could silently resurrect entries onto a second invoice.
 */
export const ProjectTimeBillingService = {
  async previewUnbilled(actor: Actor, projectId: string, opts: { from?: Date; to?: Date } = {}) {
    assertPermission(actor, "timesheet:read");
    return withTenant(actor.organizationId, async (tx) => {
      const project = await loadProjectOr404(tx, actor.organizationId, projectId);
      const rows = await queryUnbilledEntries(tx, actor.organizationId, projectId, opts);
      let totalHours = Money.zero(project.currency);
      for (const row of rows) totalHours = totalHours.add(Money.of(row.entry.hours, project.currency));
      return { entries: rows, totalHours: totalHours.toString(), currency: project.currency };
    });
  },

  async createInvoiceFromUnbilledTime(actor: Actor, input: CreateInvoiceFromUnbilledTimeInput) {
    assertPermission(actor, "customer_invoice:manage");
    assertPermission(actor, "timesheet:manage");

    // Two sequential tenant-scoped transactions, not one nested transaction
    // — the same deliberate shape as `QuoteService.convertToInvoice` (see
    // its doc comment): `InvoiceService.create` opens and commits its own
    // `withTenant` transaction, so this reads the unbilled entries first,
    // calls it, then stamps those entries INVOICED in a second transaction.
    // The structural double-billing guard doesn't depend on all of this
    // being one atomic transaction — it depends on `queryUnbilledEntries`
    // excluding anything with `invoiceId` already set, which is true the
    // instant the second transaction commits.
    const { project, customerContactId, rows, groupByTask } = await withTenant(actor.organizationId, async (tx) => {
      const project = await loadProjectOr404(tx, actor.organizationId, input.projectId);
      if (!project.customerContactId) throw new ProjectHasNoCustomerError(project.code);

      const rows = await queryUnbilledEntries(tx, actor.organizationId, input.projectId, {
        from: input.from,
        to: input.to,
      });
      if (rows.length === 0) throw new NoUnbilledTimeError();

      return { project, customerContactId: project.customerContactId, rows, groupByTask: input.groupByTask ?? true };
    });

    const invoiceLines: InvoiceLineInput[] = [];
      // Preserves, per generated invoice line, which timesheet entry ids it
      // covers — so once `InvoiceService.create` returns the real line ids
      // (in the same order the lines were submitted), each entry can be
      // stamped with the exact `invoiceLineId` it was billed on.
      const entryIdsByLineIndex: string[][] = [];

      if (groupByTask) {
        const groups = new Map<string, { taskId: string | null; label: string; rate: string; hours: Money; entryIds: string[] }>();
        for (const row of rows) {
          const rate = row.task?.billingRate ?? project.defaultHourlyRate;
          if (!rate) throw new NoBillingRateError(row.task ? `Task "${row.task.name}"` : `Project ${project.code}`);
          const key = row.entry.taskId ?? "__no_task__";
          const existing = groups.get(key);
          const hours = Money.of(row.entry.hours, project.currency);
          if (existing) {
            existing.hours = existing.hours.add(hours);
            existing.entryIds.push(row.entry.id);
          } else {
            groups.set(key, {
              taskId: row.entry.taskId,
              label: row.task ? row.task.name : `${project.name} — general time`,
              rate,
              hours,
              entryIds: [row.entry.id],
            });
          }
        }
        for (const group of groups.values()) {
          invoiceLines.push({
            description: `${group.label} (${group.hours.toString()} hrs)`,
            quantity: group.hours.toDecimal().toFixed(4),
            unitPrice: Money.of(group.rate, project.currency).toString(),
            accountId: input.revenueAccountId,
            taxCodeId: input.taxCodeId,
            projectId: project.id,
            taskId: group.taskId ?? undefined,
          });
          entryIdsByLineIndex.push(group.entryIds);
        }
      } else {
        for (const row of rows) {
          const rate = row.task?.billingRate ?? project.defaultHourlyRate;
          if (!rate) throw new NoBillingRateError(row.task ? `Task "${row.task.name}"` : `Project ${project.code}`);
          invoiceLines.push({
            description: `${row.task ? row.task.name : project.name} — ${row.entry.entryDate.toISOString().slice(0, 10)}${row.entry.notes ? `: ${row.entry.notes}` : ""}`,
            quantity: Money.of(row.entry.hours, project.currency).toDecimal().toFixed(4),
            unitPrice: Money.of(rate, project.currency).toString(),
            accountId: input.revenueAccountId,
            taxCodeId: input.taxCodeId,
            projectId: project.id,
            taskId: row.entry.taskId ?? undefined,
          });
          entryIdsByLineIndex.push([row.entry.id]);
        }
      }

      const created = await InvoiceService.create(actor, {
        customerContactId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        currency: project.currency,
        arAccountId: input.arAccountId,
        memo: `Billed time — project ${project.code}`,
        lines: invoiceLines,
      });

    // Stamp each selected entry INVOICED, linked to the exact invoice line
    // it was billed on — this is what structurally prevents a re-run from
    // ever reselecting it (`queryUnbilledEntries` filters on
    // `invoiceId IS NULL`). A second transaction, after `InvoiceService
    // .create`'s own has already committed — see this function's opening
    // comment.
    return withTenant(actor.organizationId, async (tx) => {
      const sortedLines = [...created.lines].sort((a, b) => a.lineNumber - b.lineNumber);
      for (let i = 0; i < sortedLines.length; i++) {
        const line = sortedLines[i]!;
        const entryIds = entryIdsByLineIndex[i] ?? [];
        if (entryIds.length === 0) continue;
        await tx
          .update(timesheetEntries)
          .set({
            status: "INVOICED",
            invoiceId: created.id,
            invoiceLineId: line.id,
            billedRate: invoiceLines[i]!.unitPrice,
            updatedById: actor.userId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(timesheetEntries.organizationId, actor.organizationId),
              inArray(timesheetEntries.id, entryIds),
            ),
          );
      }

      await AuditService.record(tx, actor, {
        action: "project.invoice_from_time_created",
        entityType: "Project",
        entityId: project.id,
        after: {
          invoiceId: created.id,
          invoiceNumber: created.invoiceNumber,
          entryCount: rows.length,
          lineCount: invoiceLines.length,
        },
      });

      return { invoice: created, entriesInvoiced: rows.length };
    });
  },
};
