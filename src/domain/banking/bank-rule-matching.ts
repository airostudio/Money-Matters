import Decimal from "decimal.js";
import type { BankRuleCondition } from "./types";

export interface MatchableTransaction {
  description: string;
  /** Decimal string, bank sign convention (positive = in, negative = out). */
  amount: string;
}

function matchesCondition(transaction: MatchableTransaction, condition: BankRuleCondition): boolean {
  switch (condition.operator) {
    case "CONTAINS":
      return transaction.description.toLowerCase().includes((condition.value as string).toLowerCase());
    case "EQUALS":
      return transaction.description.toLowerCase() === (condition.value as string).toLowerCase();
    case "STARTS_WITH":
      return transaction.description.toLowerCase().startsWith((condition.value as string).toLowerCase());
    case "AMOUNT_EQUALS":
      return new Decimal(transaction.amount).abs().equals(new Decimal(condition.value as string).abs());
    case "AMOUNT_BETWEEN": {
      const [min, max] = condition.value as [string, string];
      const abs = new Decimal(transaction.amount).abs();
      return abs.greaterThanOrEqualTo(new Decimal(min).abs()) && abs.lessThanOrEqualTo(new Decimal(max).abs());
    }
  }
}

/** A rule matches a transaction only when every one of its conditions matches — see docs/database.md. */
export function ruleMatches(transaction: MatchableTransaction, conditions: BankRuleCondition[]): boolean {
  if (conditions.length === 0) return false;
  return conditions.every((condition) => matchesCondition(transaction, condition));
}

export interface RuleForMatching<TAction> {
  id: string;
  priority: number;
  conditions: BankRuleCondition[];
  actions: TAction;
}

/**
 * Finds the first (lowest-priority-number) rule whose conditions all match.
 * Pure and provider-agnostic so it's usable both at import time (auto-
 * categorize new transactions) and for "preview which transactions this
 * rule would apply to" in the rule-editing UI, without touching the
 * database either time.
 */
export function findMatchingRule<TAction>(
  transaction: MatchableTransaction,
  rules: RuleForMatching<TAction>[],
): RuleForMatching<TAction> | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  return sorted.find((rule) => ruleMatches(transaction, rule.conditions)) ?? null;
}
