"use server";

import { z } from "zod";
import { requireOrgAndActor } from "@/lib/session";
import { recommendChartOfAccounts, type Recommendation } from "@/domain/onboarding/chart-of-accounts-recommender";
import {
  expandTemplate,
  groupAccounts,
  TEMPLATE_KEYS,
  type ClassificationFlags,
  type TemplateAccount,
} from "@/domain/onboarding/chart-of-accounts-templates";
import { OnboardingService } from "@/domain/onboarding/onboarding-service";
import { assertPermission } from "@/domain/permissions/permission-service";

const BusinessBasicsSchema = z.object({
  description: z.string().trim().min(1, "Tell us a little about your business").max(2000),
  country: z.string().trim().min(2).max(2),
});

export interface RecommendationResult {
  recommendation: Recommendation;
  proposedAccounts: TemplateAccount[];
  groups: ReturnType<typeof groupAccounts>;
  existingCodes: string[];
}

/** Step 2: classify the free-text description and deterministically expand it into a proposed chart. Never writes anything. */
export async function getRecommendationAction(
  orgSlug: string,
  input: { description: string; country: string; industry?: string },
): Promise<RecommendationResult> {
  const { actor } = await requireOrgAndActor(orgSlug);
  assertPermission(actor, "onboarding:manage");

  const parsed = BusinessBasicsSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  const recommendation = await recommendChartOfAccounts({
    description: parsed.data.description,
    country: parsed.data.country,
    industry: input.industry,
  });

  const proposedAccounts = expandTemplate(recommendation.templateKey, recommendation.flags);
  const existing = await OnboardingService.getExistingAccounts(actor);
  const existingCodes = new Set(existing.map((a) => a.code));
  const newAccounts = proposedAccounts.filter((a) => !existingCodes.has(a.code));

  return {
    recommendation,
    proposedAccounts: newAccounts,
    groups: groupAccounts(newAccounts),
    existingCodes: [...existingCodes],
  };
}

const ApplyAccountSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  type: z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]),
  subType: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
});

const ApplySchema = z.object({
  templateKey: z.enum(TEMPLATE_KEYS),
  flags: z.object({
    sellsGoods: z.boolean(),
    sellsServices: z.boolean(),
    hasEmployees: z.boolean(),
    tracksInventory: z.boolean(),
  }),
  accounts: z.array(ApplyAccountSchema).min(1, "Add at least one account"),
  recommendation: z
    .object({
      source: z.enum(["AI", "DETERMINISTIC"]),
      model: z.string().optional(),
      confidence: z.number(),
      reasoning: z.string(),
    })
    .optional(),
});

export interface ApplyResult {
  createdCount: number;
  skippedCount: number;
  createdAssetAccounts: Array<{ id: string; code: string; name: string }>;
}

/** Step 3: create every account the user confirmed, via AccountService.create — safely re-runnable. */
export async function applyChartOfAccountsAction(
  orgSlug: string,
  payload: {
    templateKey: string;
    flags: ClassificationFlags;
    accounts: TemplateAccount[];
    recommendation?: {
      source: "AI" | "DETERMINISTIC";
      model?: string;
      confidence: number;
      reasoning: string;
    };
  },
): Promise<ApplyResult> {
  const { actor, org } = await requireOrgAndActor(orgSlug);
  assertPermission(actor, "onboarding:manage");

  const parsed = ApplySchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid input.");
  }

  const created = await OnboardingService.applyChartOfAccounts(actor, {
    templateKey: parsed.data.templateKey,
    flags: parsed.data.flags,
    baseCurrency: org.baseCurrency,
    accountsToCreate: parsed.data.accounts,
    recommendation: parsed.data.recommendation,
  });

  return {
    createdCount: created.length,
    skippedCount: parsed.data.accounts.length - created.length,
    createdAssetAccounts: created
      .filter((a) => a.type === "ASSET")
      .map((a) => ({ id: a.id, code: a.code, name: a.name })),
  };
}

/** Whether onboarding still has meaningful work to do — used by the dashboard banner and to resume the wizard at the right step. */
export async function getOnboardingStatusAction(orgSlug: string) {
  const { actor } = await requireOrgAndActor(orgSlug);
  const accounts = await OnboardingService.getExistingAccounts(actor);
  const nonSystemAccounts = accounts.filter((a) => !a.isSystemAccount);
  const assetAccounts = accounts.filter((a) => a.type === "ASSET");
  return {
    hasChartOfAccounts: nonSystemAccounts.length > 0,
    hasAssetAccount: assetAccounts.length > 0,
    canManageOnboarding: (() => {
      try {
        assertPermission(actor, "onboarding:manage");
        return true;
      } catch {
        return false;
      }
    })(),
  };
}
