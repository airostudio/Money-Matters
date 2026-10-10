import { describe, expect, it } from "vitest";
import {
  AUTO_APPROVABLE_ACTION_TYPES,
  EXCLUDED_ACTION_TYPE_EXAMPLES,
  InvalidAutoApprovedActionTypeError,
  isAutoApprovableActionType,
} from "@/domain/ai-controller/auto-execution-policy";

/**
 * Phase 6 Slice 3's most safety-critical property, proven WITHOUT a database:
 * the closed set of action types an organization may ever whitelist for
 * auto-execution structurally excludes anything master spec §8 names as
 * always requiring authorisation — supplier payments/payment runs, bank
 * account details, payroll, tax, unusual journal entries, fiscal period
 * closes — at Level 3 OR Level 4. There is no "everything except the
 * excluded list" inversion anywhere in this codebase: the allowlist alone
 * decides what can ever be whitelisted, and it is small and hand-curated.
 */
describe("auto-execution-policy — the whitelist's closed allowlist", () => {
  it("is a small, specific, hand-curated set — not 'everything except excluded'", () => {
    expect(AUTO_APPROVABLE_ACTION_TYPES).toEqual([
      "RECURRING_INVOICE_AUTO_GENERATE",
      "RECURRING_BILL_AUTO_GENERATE",
      "BANK_RECONCILIATION_AUTO_MATCH",
    ]);
  });

  it("never contains anything resembling a payment, bank-detail, payroll, tax, unusual-journal, or period-close action", () => {
    const disallowedPatterns = [/PAYMENT/i, /BANK_ACCOUNT/i, /PAYROLL/i, /TAX/i, /JOURNAL/i, /PERIOD/i, /CLOSE/i];
    for (const actionType of AUTO_APPROVABLE_ACTION_TYPES) {
      for (const pattern of disallowedPatterns) {
        expect(actionType).not.toMatch(pattern);
      }
    }
  });

  it("is disjoint from the documented excluded-category examples", () => {
    const allowed = new Set<string>(AUTO_APPROVABLE_ACTION_TYPES);
    for (const excluded of EXCLUDED_ACTION_TYPE_EXAMPLES) {
      expect(allowed.has(excluded)).toBe(false);
    }
  });

  it("isAutoApprovableActionType refuses every excluded example", () => {
    for (const excluded of EXCLUDED_ACTION_TYPE_EXAMPLES) {
      expect(isAutoApprovableActionType(excluded)).toBe(false);
    }
  });

  it("isAutoApprovableActionType accepts only the three real action types", () => {
    for (const actionType of AUTO_APPROVABLE_ACTION_TYPES) {
      expect(isAutoApprovableActionType(actionType)).toBe(true);
    }
    expect(isAutoApprovableActionType("something_made_up")).toBe(false);
  });

  it("InvalidAutoApprovedActionTypeError names the rejected value", () => {
    const err = new InvalidAutoApprovedActionTypeError("SUPPLIER_PAYMENT_CREATE");
    expect(err.message).toContain("SUPPLIER_PAYMENT_CREATE");
    expect(err.message).toContain("RECURRING_INVOICE_AUTO_GENERATE");
  });
});
