import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { actorWithRole, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { AccountService } from "@/domain/accounts/account-service";
import { BankAccountService } from "@/domain/banking/bank-account-service";
import { PermissionDeniedError } from "@/domain/permissions/permission-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { recommendChartOfAccounts } from "@/domain/onboarding/chart-of-accounts-recommender";
import { expandTemplate } from "@/domain/onboarding/chart-of-accounts-templates";
import { OnboardingService } from "@/domain/onboarding/onboarding-service";

describe("Onboarding wizard (integration)", () => {
  afterAll(async () => {
    await closeTestPools();
  });

  let owner: Actor;
  let baseCurrency: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("onboarding");
    owner = org.owner;
    baseCurrency = org.baseCurrency;
    // No ANTHROPIC_API_KEY is configured in tests — every recommendation
    // call below exercises the deterministic fallback path only.
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("runs the full flow: business basics -> recommendation -> confirm -> accounts created -> bank account linked", async () => {
    // Step 1 + 2: classify the free-text description (deterministic fallback, no network).
    const recommendation = await recommendChartOfAccounts({
      description: "We're an electrical contracting company in Melbourne with 5 employees",
      country: "AU",
    });
    expect(recommendation.source).toBe("DETERMINISTIC");
    expect(recommendation.templateKey).toBe("TRADES");

    const proposedAccounts = expandTemplate(recommendation.templateKey, recommendation.flags);
    expect(proposedAccounts.length).toBeGreaterThan(5);

    // Step 3: create the (unedited) proposed chart of accounts.
    const created = await OnboardingService.applyChartOfAccounts(owner, {
      templateKey: recommendation.templateKey,
      flags: recommendation.flags,
      baseCurrency,
      accountsToCreate: proposedAccounts,
      recommendation: {
        source: recommendation.source,
        confidence: recommendation.confidence,
        reasoning: recommendation.reasoning,
      },
    });
    expect(created.length).toBe(proposedAccounts.length);

    const accountsAfter = await AccountService.list(owner);
    // The 2 starter system accounts plus every proposed account.
    expect(accountsAfter.length).toBe(2 + proposedAccounts.length);

    const bankGlAccount = accountsAfter.find((a) => a.code === "1000" && a.type === "ASSET");
    expect(bankGlAccount).toBeDefined();

    // Step 4: link a bank account against the newly created default ASSET account.
    const bankAccount = await BankAccountService.create(owner, {
      name: "Everyday Account",
      glAccountId: bankGlAccount!.id,
      currency: baseCurrency,
      institutionName: "Test Bank",
    });
    expect(bankAccount.glAccountId).toBe(bankGlAccount!.id);
  });

  it("is safely re-runnable: running onboarding again on an org that already has accounts adds nothing twice", async () => {
    const recommendation = await recommendChartOfAccounts({
      description: "A small cafe serving coffee and lunch",
      country: "AU",
    });
    const proposedAccounts = expandTemplate(recommendation.templateKey, recommendation.flags);

    const firstRun = await OnboardingService.applyChartOfAccounts(owner, {
      templateKey: recommendation.templateKey,
      flags: recommendation.flags,
      baseCurrency,
      accountsToCreate: proposedAccounts,
    });
    expect(firstRun.length).toBe(proposedAccounts.length);

    // Re-run the exact same wizard output again, as if the user reloaded onboarding.
    const secondRun = await OnboardingService.applyChartOfAccounts(owner, {
      templateKey: recommendation.templateKey,
      flags: recommendation.flags,
      baseCurrency,
      accountsToCreate: proposedAccounts,
    });
    expect(secondRun.length).toBe(0);

    const accounts = await AccountService.list(owner);
    // Still exactly 2 starter accounts + the template's accounts, no duplicates.
    expect(accounts.length).toBe(2 + proposedAccounts.length);
    const codes = accounts.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("never recreates or fails on the two starter system accounts already present", async () => {
    const existing = await OnboardingService.getExistingAccounts(owner);
    expect(existing.length).toBe(2);
    expect(existing.every((a) => a.isSystemAccount)).toBe(true);

    const proposedAccounts = expandTemplate("GENERAL", {
      sellsGoods: false,
      sellsServices: true,
      hasEmployees: false,
      tracksInventory: false,
    });

    // GENERAL includes an EQUITY account (Owner's Drawings, code 3100) that
    // does not collide with the starter accounts' codes (3000/3900) — this
    // proves onboarding can safely run even though EQUITY accounts already
    // exist for this organization.
    const created = await OnboardingService.applyChartOfAccounts(owner, {
      templateKey: "GENERAL",
      flags: { sellsGoods: false, sellsServices: true, hasEmployees: false, tracksInventory: false },
      baseCurrency,
      accountsToCreate: proposedAccounts,
    });
    expect(created.length).toBe(proposedAccounts.length);

    const accounts = await AccountService.list(owner);
    expect(accounts.filter((a) => a.isSystemAccount).length).toBe(2);
  });

  it("lets the user edit the proposed list before anything is created — removed accounts are never created", async () => {
    const recommendation = await recommendChartOfAccounts({ description: "A retail shop selling shoes", country: "AU" });
    const proposedAccounts = expandTemplate(recommendation.templateKey, recommendation.flags);
    const edited = proposedAccounts.filter((a) => a.name !== "Business Savings Account");

    const created = await OnboardingService.applyChartOfAccounts(owner, {
      templateKey: recommendation.templateKey,
      flags: recommendation.flags,
      baseCurrency,
      accountsToCreate: edited,
    });

    const accounts = await AccountService.list(owner);
    expect(accounts.some((a) => a.name === "Business Savings Account")).toBe(false);
    expect(created.length).toBe(edited.length);
  });

  it("requires onboarding:manage — a non-owner/administrator role cannot apply the chart of accounts", async () => {
    const bookkeeper = actorWithRole(owner, "BOOKKEEPER");
    await expect(
      OnboardingService.applyChartOfAccounts(bookkeeper, {
        templateKey: "GENERAL",
        flags: { sellsGoods: false, sellsServices: true, hasEmployees: false, tracksInventory: false },
        baseCurrency,
        accountsToCreate: expandTemplate("GENERAL", {
          sellsGoods: false,
          sellsServices: true,
          hasEmployees: false,
          tracksInventory: false,
        }),
      }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("ADMINISTRATOR can also run onboarding", async () => {
    const admin = actorWithRole(owner, "ADMINISTRATOR");
    const proposedAccounts = expandTemplate("PROFESSIONAL_SERVICES", {
      sellsGoods: false,
      sellsServices: true,
      hasEmployees: true,
      tracksInventory: false,
    });
    const created = await OnboardingService.applyChartOfAccounts(admin, {
      templateKey: "PROFESSIONAL_SERVICES",
      flags: { sellsGoods: false, sellsServices: true, hasEmployees: true, tracksInventory: false },
      baseCurrency,
      accountsToCreate: proposedAccounts,
    });
    expect(created.length).toBe(proposedAccounts.length);
  });
});
