import { and, asc, eq } from "drizzle-orm";
import { bankRules } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { AuditService } from "@/domain/audit/audit-service";
import { BankRuleNotFoundError } from "./errors";
import type { BankRuleAction, BankRuleCondition } from "./types";

export interface CreateBankRuleInput {
  name: string;
  /** Null/omitted applies to every bank account in the organization. */
  bankAccountId?: string | null;
  priority?: number;
  conditions: BankRuleCondition[];
  actions: BankRuleAction;
}

export const BankRuleService = {
  async list(actor: Actor, opts: { bankAccountId?: string } = {}) {
    assertPermission(actor, "bank_account:read");
    return withTenant(actor.organizationId, (tx) =>
      tx
        .select()
        .from(bankRules)
        .where(eq(bankRules.organizationId, actor.organizationId))
        .orderBy(asc(bankRules.priority)),
    ).then((rows) =>
      opts.bankAccountId
        ? rows.filter((r) => r.bankAccountId === null || r.bankAccountId === opts.bankAccountId)
        : rows,
    );
  },

  async create(actor: Actor, input: CreateBankRuleInput) {
    assertPermission(actor, "bank_rule:manage");
    if (input.conditions.length === 0) {
      throw new Error("A bank rule needs at least one condition.");
    }
    return withTenant(actor.organizationId, async (tx) => {
      const [rule] = await tx
        .insert(bankRules)
        .values({
          organizationId: actor.organizationId,
          bankAccountId: input.bankAccountId ?? null,
          name: input.name,
          priority: input.priority ?? 100,
          conditions: input.conditions,
          actions: input.actions,
          createdById: actor.userId,
        })
        .returning();
      if (!rule) throw new Error("Failed to create bank rule.");

      await AuditService.record(tx, actor, {
        action: "bank_rule.created",
        entityType: "BankRule",
        entityId: rule.id,
        after: rule,
      });

      return rule;
    });
  },

  async setActive(actor: Actor, bankRuleId: string, isActive: boolean) {
    assertPermission(actor, "bank_rule:manage");
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(bankRules)
        .where(and(eq(bankRules.id, bankRuleId), eq(bankRules.organizationId, actor.organizationId)));
      if (!existing) throw new BankRuleNotFoundError(bankRuleId);

      const [updated] = await tx
        .update(bankRules)
        .set({ isActive, updatedAt: new Date() })
        .where(eq(bankRules.id, bankRuleId))
        .returning();

      await AuditService.record(tx, actor, {
        action: isActive ? "bank_rule.reactivated" : "bank_rule.deactivated",
        entityType: "BankRule",
        entityId: bankRuleId,
        before: { isActive: existing.isActive },
        after: { isActive },
      });

      return updated;
    });
  },
};
