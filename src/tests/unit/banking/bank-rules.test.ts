import { describe, expect, it } from "vitest";
import { findMatchingRule, ruleMatches, type RuleForMatching } from "@/domain/banking/bank-rule-matching";
import type { BankRuleCondition } from "@/domain/banking/types";

describe("ruleMatches", () => {
  it("matches when every condition matches (AND semantics)", () => {
    const conditions: BankRuleCondition[] = [
      { field: "description", operator: "CONTAINS", value: "STRIPE" },
      { field: "amount", operator: "AMOUNT_BETWEEN", value: ["0", "1000"] },
    ];
    expect(ruleMatches({ description: "STRIPE PAYOUT", amount: "150.00" }, conditions)).toBe(true);
  });

  it("fails when any single condition fails", () => {
    const conditions: BankRuleCondition[] = [
      { field: "description", operator: "CONTAINS", value: "STRIPE" },
      { field: "amount", operator: "AMOUNT_BETWEEN", value: ["0", "100"] },
    ];
    expect(ruleMatches({ description: "STRIPE PAYOUT", amount: "150.00" }, conditions)).toBe(false);
  });

  it("is case-insensitive for text conditions", () => {
    const conditions: BankRuleCondition[] = [{ field: "description", operator: "CONTAINS", value: "coffee" }];
    expect(ruleMatches({ description: "MORNING COFFEE CO", amount: "-5" }, conditions)).toBe(true);
  });

  it("AMOUNT_EQUALS compares magnitude, ignoring the bank sign convention", () => {
    const conditions: BankRuleCondition[] = [{ field: "amount", operator: "AMOUNT_EQUALS", value: "45.00" }];
    expect(ruleMatches({ description: "x", amount: "-45.00" }, conditions)).toBe(true);
    expect(ruleMatches({ description: "x", amount: "45.00" }, conditions)).toBe(true);
    expect(ruleMatches({ description: "x", amount: "45.01" }, conditions)).toBe(false);
  });

  it("a rule with no conditions never matches", () => {
    expect(ruleMatches({ description: "anything", amount: "1" }, [])).toBe(false);
  });
});

describe("findMatchingRule", () => {
  it("returns the lowest-priority-number matching rule", () => {
    const rules: RuleForMatching<{ label: string }>[] = [
      {
        id: "low-priority",
        priority: 200,
        conditions: [{ field: "description", operator: "CONTAINS", value: "coffee" }],
        actions: { label: "low" },
      },
      {
        id: "high-priority",
        priority: 10,
        conditions: [{ field: "description", operator: "CONTAINS", value: "coffee" }],
        actions: { label: "high" },
      },
    ];
    const match = findMatchingRule({ description: "Morning Coffee", amount: "-5" }, rules);
    expect(match?.id).toBe("high-priority");
  });

  it("returns null when nothing matches", () => {
    const rules: RuleForMatching<null>[] = [
      { id: "a", priority: 1, conditions: [{ field: "description", operator: "CONTAINS", value: "xyz" }], actions: null },
    ];
    expect(findMatchingRule({ description: "unrelated", amount: "1" }, rules)).toBeNull();
  });
});
