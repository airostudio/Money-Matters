import { and, asc, eq } from "drizzle-orm";
import { accounts, type accountTypeEnum } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";

export type AccountType = (typeof accountTypeEnum.enumValues)[number];

export class DuplicateAccountCodeError extends Error {
  constructor(code: string) {
    super(`Account code "${code}" is already in use in this organization.`);
    this.name = "DuplicateAccountCodeError";
  }
}

export class AccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} was not found in this organization.`);
    this.name = "AccountNotFoundError";
  }
}

export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  subType?: string;
  isControlAccount?: boolean;
  description?: string;
  parentAccountId?: string;
}

export interface UpdateAccountInput {
  name?: string;
  subType?: string;
  description?: string;
  parentAccountId?: string | null;
}

export const AccountService = {
  async list(actor: Actor, opts: { includeInactive?: boolean } = {}) {
    assertPermission(actor, "account:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(accounts)
        .where(
          opts.includeInactive
            ? eq(accounts.organizationId, actor.organizationId)
            : and(eq(accounts.organizationId, actor.organizationId), eq(accounts.isActive, true)),
        )
        .orderBy(asc(accounts.code)),
    );
  },

  async get(actor: Actor, accountId: string) {
    assertPermission(actor, "account:read");
    return withTenant(actor.organizationId, async (tx) => {
      const [account] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, actor.organizationId)));
      return account ?? null;
    });
  },

  async create(actor: Actor, input: CreateAccountInput, opts: { isSystemAccount?: boolean } = {}) {
    assertPermission(actor, "account:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.organizationId, actor.organizationId), eq(accounts.code, input.code)));
      if (existing) {
        throw new DuplicateAccountCodeError(input.code);
      }

      const [account] = await tx
        .insert(accounts)
        .values({
          organizationId: actor.organizationId,
          code: input.code,
          name: input.name,
          type: input.type,
          currency: input.currency,
          subType: input.subType ?? null,
          isControlAccount: input.isControlAccount ?? false,
          isSystemAccount: opts.isSystemAccount ?? false,
          description: input.description ?? null,
          parentAccountId: input.parentAccountId ?? null,
          createdById: actor.userId,
          updatedById: actor.userId,
        })
        .returning();

      if (!account) throw new Error("Failed to create account.");

      await AuditService.record(tx, actor, {
        action: "account.created",
        entityType: "Account",
        entityId: account.id,
        after: account,
      });

      return account;
    });
  },

  async update(actor: Actor, accountId: string, input: UpdateAccountInput) {
    assertPermission(actor, "account:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, actor.organizationId)));
      if (!existing) throw new AccountNotFoundError(accountId);

      const [updated] = await tx
        .update(accounts)
        .set({
          name: input.name ?? existing.name,
          subType: input.subType !== undefined ? input.subType : existing.subType,
          description: input.description !== undefined ? input.description : existing.description,
          parentAccountId:
            input.parentAccountId !== undefined ? input.parentAccountId : existing.parentAccountId,
          updatedById: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, accountId))
        .returning();

      await AuditService.record(tx, actor, {
        action: "account.updated",
        entityType: "Account",
        entityId: accountId,
        before: existing,
        after: updated,
      });

      return updated;
    });
  },

  /** Accounts are never hard-deleted once they can be referenced by posted history — only deactivated/reactivated. */
  async setActive(actor: Actor, accountId: string, isActive: boolean) {
    assertPermission(actor, "account:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, actor.organizationId)));
      if (!existing) throw new AccountNotFoundError(accountId);

      const [updated] = await tx
        .update(accounts)
        .set({ isActive, updatedById: actor.userId, updatedAt: new Date() })
        .where(eq(accounts.id, accountId))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "account.reactivated" : "account.deactivated",
        entityType: "Account",
        entityId: accountId,
        before: { isActive: existing.isActive },
        after: { isActive },
      });

      return updated;
    });
  },
};
