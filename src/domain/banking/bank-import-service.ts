import { and, eq, inArray } from "drizzle-orm";
import { bankAccounts, bankImportBatches, bankRules, bankTransactions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { BankAccountNotFoundError } from "./errors";
import { assignExternalIds } from "./external-id";
import { findMatchingRule, ruleMatches } from "./bank-rule-matching";
import { parseStatement, type ParseStatementOptions } from "./parsers";
import type { BankImportFormat, BankRuleAction, BankRuleCondition } from "./types";

export interface ImportStatementInput {
  bankAccountId: string;
  format: BankImportFormat;
  fileName?: string;
  text: string;
  parseOptions?: ParseStatementOptions;
}

export interface ImportStatementResult {
  batchId: string;
  rowCount: number;
  importedRowCount: number;
  duplicateRowCount: number;
  warnings: string[];
}

export const BankImportService = {
  /**
   * Parses a statement export and stages its transactions. Nothing here
   * touches the ledger — an imported transaction is not a journal entry
   * until it's reconciled (`ReconciliationService`), so a bad import can
   * always be deleted with zero accounting consequence.
   *
   * Duplicate-safe by construction: `externalId` (the provider's own id, or
   * a content hash — see external-id.ts) is unique per bank account, so
   * re-importing the same file, or an overlapping date range, inserts
   * nothing for rows already on file. Auto-categorization then runs each
   * newly-inserted row through the account's bank rules in priority order.
   */
  async importStatement(actor: Actor, input: ImportStatementInput): Promise<ImportStatementResult> {
    assertPermission(actor, "bank_transaction:import");

    const parsed = parseStatement(input.format, input.text, input.parseOptions);

    return withTenant(actor.organizationId, async (tx) => {
      const [bankAccount] = await tx
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.organizationId, actor.organizationId)));
      if (!bankAccount) throw new BankAccountNotFoundError(input.bankAccountId);

      const rowsWithIds = assignExternalIds(parsed.rows);

      const existingIds = rowsWithIds.length
        ? await tx
            .select({ externalId: bankTransactions.externalId })
            .from(bankTransactions)
            .where(
              and(
                eq(bankTransactions.bankAccountId, input.bankAccountId),
                inArray(
                  bankTransactions.externalId,
                  rowsWithIds.map((r) => r.externalId!),
                ),
              ),
            )
        : [];
      const existingIdSet = new Set(existingIds.map((r) => r.externalId));
      const newRows = rowsWithIds.filter((r) => !existingIdSet.has(r.externalId!));

      const rules = await tx
        .select()
        .from(bankRules)
        .where(
          and(
            eq(bankRules.organizationId, actor.organizationId),
            eq(bankRules.isActive, true),
          ),
        );
      const applicableRules = rules
        .filter((r) => r.bankAccountId === null || r.bankAccountId === input.bankAccountId)
        .map((r) => ({
          id: r.id,
          priority: r.priority,
          conditions: r.conditions as BankRuleCondition[],
          actions: r.actions as BankRuleAction,
        }));

      const [batch] = await tx
        .insert(bankImportBatches)
        .values({
          organizationId: actor.organizationId,
          bankAccountId: input.bankAccountId,
          format: input.format,
          fileName: input.fileName ?? null,
          rowCount: parsed.rows.length,
          importedRowCount: newRows.length,
          duplicateRowCount: rowsWithIds.length - newRows.length,
          importedById: actor.userId,
        })
        .returning();
      if (!batch) throw new Error("Failed to record the import batch.");

      if (newRows.length > 0) {
        await tx.insert(bankTransactions).values(
          newRows.map((row) => {
            const rule = findMatchingRule({ description: row.description, amount: row.amount }, applicableRules);
            return {
              organizationId: actor.organizationId,
              bankAccountId: input.bankAccountId,
              importBatchId: batch.id,
              externalId: row.externalId!,
              postedDate: row.postedDate,
              description: row.description,
              amount: row.amount,
              currency: bankAccount.currency,
              balanceAfter: row.balanceAfter ?? null,
              rawPayload: row.raw,
              categorizedAccountId: rule?.actions.categorizedAccountId ?? null,
              contactId: rule?.actions.contactId ?? null,
              appliedRuleId: rule?.id ?? null,
            };
          }),
        );
      }

      await AuditService.record(tx, actor, {
        action: "bank_transaction.imported",
        entityType: "BankImportBatch",
        entityId: batch.id,
        after: {
          bankAccountId: input.bankAccountId,
          format: input.format,
          rowCount: parsed.rows.length,
          importedRowCount: newRows.length,
          duplicateRowCount: rowsWithIds.length - newRows.length,
        },
      });

      return {
        batchId: batch.id,
        rowCount: parsed.rows.length,
        importedRowCount: newRows.length,
        duplicateRowCount: rowsWithIds.length - newRows.length,
        warnings: parsed.warnings,
      };
    });
  },
};

// Re-exported so callers (e.g. a rule-editing UI) can preview which of an
// account's already-imported transactions a draft rule would have matched,
// without duplicating the matching logic.
export { ruleMatches };
