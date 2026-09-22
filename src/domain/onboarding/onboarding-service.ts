import { asc, eq } from "drizzle-orm";
import { accounts } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AccountService } from "@/domain/accounts/account-service";
import { AuditService } from "@/domain/audit/audit-service";
import { assertPermission, type Actor } from "@/domain/permissions/permission-service";
import {
  expandTemplate,
  TEMPLATE_LIBRARY_VERSION,
  type ClassificationFlags,
  type TemplateAccount,
  type TemplateKey,
} from "./chart-of-accounts-templates";

export interface ApplyChartOfAccountsInput {
  templateKey: TemplateKey;
  flags: ClassificationFlags;
  /** The organization's base currency — every created account is denominated in it. */
  baseCurrency: string;
  /** The final, possibly user-edited, list of accounts to create. */
  accountsToCreate: TemplateAccount[];
  /** Recorded on the audit log so the AI's contribution (or its absence) is traceable — master spec §6. */
  recommendation?: {
    source: "AI" | "DETERMINISTIC";
    model?: string;
    confidence: number;
    reasoning: string;
  };
}

/**
 * Onboarding wizard operations (master spec §60). Every account this
 * creates goes through `AccountService.create` — nothing here ever writes
 * to the `accounts` table directly, and nothing the AI recommender returns
 * reaches the ledger without first passing through the deterministic
 * template expansion in `chart-of-accounts-templates.ts`.
 */
export const OnboardingService = {
  /** The organization's current accounts, for deciding what onboarding still needs to do (safe to re-run). */
  async getExistingAccounts(actor: Actor) {
    assertPermission(actor, "onboarding:manage");
    return withTenant(actor.organizationId, (tx) =>
      tx.select().from(accounts).where(eq(accounts.organizationId, actor.organizationId)).orderBy(asc(accounts.code)),
    );
  },

  /**
   * Creates every account in `accountsToCreate` that doesn't already exist
   * (by code) for this organization, via `AccountService.create`. Safe to
   * call multiple times / partway through a previous attempt — accounts
   * that already exist (including the two starter system accounts from
   * `OrganizationService.createWithOwner`) are left untouched, never
   * recreated or duplicated.
   */
  async applyChartOfAccounts(actor: Actor, input: ApplyChartOfAccountsInput) {
    assertPermission(actor, "onboarding:manage");

    const existing = await this.getExistingAccounts(actor);
    const existingCodes = new Set(existing.map((a) => a.code));

    const created: Array<Awaited<ReturnType<typeof AccountService.create>>> = [];
    for (const account of input.accountsToCreate) {
      if (existingCodes.has(account.code)) continue;
      const row = await AccountService.create(actor, {
        code: account.code,
        name: account.name,
        type: account.type,
        currency: input.baseCurrency,
        subType: account.subType,
        description: account.description,
      });
      created.push(row);
      existingCodes.add(account.code);
    }

    await withTenant(actor.organizationId, (tx) =>
      AuditService.record(tx, actor, {
        action: "onboarding.chart_of_accounts_applied",
        entityType: "Organization",
        entityId: actor.organizationId,
        after: {
          templateKey: input.templateKey,
          templateLibraryVersion: TEMPLATE_LIBRARY_VERSION,
          flags: input.flags,
          createdAccountCodes: created.map((a) => a.code),
          skippedExistingCodes: input.accountsToCreate
            .filter((a) => !created.some((c) => c.code === a.code))
            .map((a) => a.code),
        },
        metadata: input.recommendation
          ? {
              recommendationSource: input.recommendation.source,
              model: input.recommendation.model,
              confidence: input.recommendation.confidence,
              reasoning: input.recommendation.reasoning,
            }
          : undefined,
      }),
    );

    return created;
  },

  expandTemplate,
};
