import { describe, expect, it } from "vitest";
import {
  DEFAULT_BANK_ACCOUNT_CODE,
  DEFAULT_FLAGS,
  TEMPLATE_KEYS,
  expandTemplate,
  groupAccounts,
} from "@/domain/onboarding/chart-of-accounts-templates";

describe("chart-of-accounts templates", () => {
  it.each(TEMPLATE_KEYS)("expands %s with default flags into a realistic, balanced-type chart", (key) => {
    const accounts = expandTemplate(key, DEFAULT_FLAGS);
    const groups = groupAccounts(accounts);

    expect(groups.ASSET.length).toBeGreaterThan(0);
    expect(groups.LIABILITY.length).toBeGreaterThan(0);
    expect(groups.EQUITY.length).toBeGreaterThan(0);
    expect(groups.REVENUE.length).toBeGreaterThan(0);
    expect(groups.EXPENSE.length).toBeGreaterThan(0);

    // Every template must offer the default bank account code so step 4 can
    // always pre-select a sensible ASSET account.
    expect(accounts.some((a) => a.code === DEFAULT_BANK_ACCOUNT_CODE && a.type === "ASSET")).toBe(true);

    // No duplicate codes within a single expansion.
    const codes = accounts.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("omits inventory and COGS accounts when tracksInventory/sellsGoods are false", () => {
    const accounts = expandTemplate("GENERAL", {
      sellsGoods: false,
      sellsServices: true,
      hasEmployees: false,
      tracksInventory: false,
    });
    expect(accounts.some((a) => a.name === "Inventory")).toBe(false);
    expect(accounts.some((a) => a.name === "Cost of Goods Sold")).toBe(false);
  });

  it("includes inventory when tracksInventory is true", () => {
    const accounts = expandTemplate("GENERAL", {
      sellsGoods: true,
      sellsServices: false,
      hasEmployees: false,
      tracksInventory: true,
    });
    expect(accounts.some((a) => a.name === "Inventory")).toBe(true);
    expect(accounts.some((a) => a.name === "Cost of Goods Sold")).toBe(true);
  });

  it("omits payroll accounts when hasEmployees is false, includes them when true", () => {
    const without = expandTemplate("TRADES", { ...DEFAULT_FLAGS, hasEmployees: false });
    const withEmployees = expandTemplate("TRADES", { ...DEFAULT_FLAGS, hasEmployees: true });

    expect(without.some((a) => a.name === "Wages & Salaries")).toBe(false);
    expect(without.some((a) => a.name === "PAYG Withholding Payable")).toBe(false);

    expect(withEmployees.some((a) => a.name === "Wages & Salaries")).toBe(true);
    expect(withEmployees.some((a) => a.name === "PAYG Withholding Payable")).toBe(true);
    expect(withEmployees.some((a) => a.name === "Superannuation Payable")).toBe(true);
  });

  it("RETAIL and HOSPITALITY always track inventory regardless of the flag (the template itself always includes it)", () => {
    const retail = expandTemplate("RETAIL", { ...DEFAULT_FLAGS, tracksInventory: false });
    expect(retail.some((a) => a.name === "Inventory")).toBe(true);
  });

  it("falls back to GENERAL for an unknown key", () => {
    // @ts-expect-error deliberately invalid input
    const accounts = expandTemplate("NOT_A_TEMPLATE", DEFAULT_FLAGS);
    expect(accounts.length).toBeGreaterThan(0);
  });
});
