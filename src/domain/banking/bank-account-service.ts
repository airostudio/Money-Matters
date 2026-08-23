import { and, eq } from "drizzle-orm";
import { accounts, bankAccounts } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { BankAccountNotFoundError, DuplicateBankAccountError } from "./errors";

export interface CreateBankAccountInput {
  name: string;
  /** Must be an ASSET account the org already has — a bank account with no ledger home can't be reconciled against. */
  glAccountId: string;
  currency: string;
  institutionName?: string;
  accountNumberLast4?: string;
  openingBalance?: string;
}

export const BankAccountService = {
  async list(actor: Actor, opts: { includeInactive?: boolean } = {}) {
    assertPermission(actor, "bank_account:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(bankAccounts)
        .where(
          opts.includeInactive
            ? eq(bankAccounts.organizationId, actor.organizationId)
            : and(eq(bankAccounts.organizationId, actor.organizationId), eq(bankAccounts.isActive, true)),
        ),
    );
  },

  async get(actor: Actor, bankAccountId: string) {
    assertPermission(actor, "bank_account:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [row] = await tx
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.organizationId, actor.organizationId)));
      return row ?? null;
    });
  },

  async create(actor: Actor, input: CreateBankAccountInput) {
    assertPermission(actor, "bank_account:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [glAccount] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.glAccountId), eq(accounts.organizationId, actor.organizationId)));
      if (!glAccount) {
        throw new Error(`Ledger account ${input.glAccountId} was not found in this organization.`);
      }
      if (glAccount.type !== "ASSET") {
        throw new Error(`Ledger account "${glAccount.name}" is a ${glAccount.type} account — a bank account must be linked to an ASSET account.`);
      }

      const [existing] = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(
          and(
            eq(bankAccounts.organizationId, actor.organizationId),
            eq(bankAccounts.glAccountId, input.glAccountId),
          ),
        );
      if (existing) throw new DuplicateBankAccountError();

      const [bankAccount] = await tx
        .insert(bankAccounts)
        .values({
          organizationId: actor.organizationId,
          glAccountId: input.glAccountId,
          name: input.name,
          currency: input.currency,
          institutionName: input.institutionName ?? null,
          accountNumberLast4: input.accountNumberLast4 ?? null,
          currentBalance: input.openingBalance ?? null,
          currentBalanceAsOf: input.openingBalance ? new Date() : null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();
      if (!bankAccount) throw new Error("Failed to create bank account.");

      await AuditService.record(tx, actor, {
        action: "bank_account.created",
        entityType: "BankAccount",
        entityId: bankAccount.id,
        after: bankAccount,
      });

      return bankAccount;
    });
  },

  async setActive(actor: Actor, bankAccountId: string, isActive: boolean) {
    assertPermission(actor, "bank_account:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.organizationId, actor.organizationId)));
      if (!existing) throw new BankAccountNotFoundError(bankAccountId);

      const [updated] = await tx
        .update(bankAccounts)
        .set({ isActive, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(bankAccounts.id, bankAccountId))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "bank_account.reactivated" : "bank_account.deactivated",
        entityType: "BankAccount",
        entityId: bankAccountId,
        before: { isActive: existing.isActive },
        after: { isActive },
      });

      return updated;
    });
  },
};
