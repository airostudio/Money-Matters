import { describe, expect, it } from "vitest";
import {
  describeRouting,
  policyInputSchema,
  policyMatches,
  selectPolicy,
  type DocumentFacts,
  type PolicyRow,
} from "@/domain/approvals/policy";
import { evaluateEligibility } from "@/domain/approvals/approval-service";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const SUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRJ = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let n = 0;
function policy(over: Partial<PolicyRow> = {}): PolicyRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `P${n}`,
    documentType: "SUPPLIER_BILL",
    priority: 100,
    isActive: true,
    minAmount: null,
    maxAmount: null,
    filters: {},
    steps: [{ name: "Finance", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 }],
    allowSamePersonMultipleSteps: false,
    createdAt: new Date(2026, 0, n),
    ...over,
  };
}

const facts = (over: Partial<DocumentFacts> = {}): DocumentFacts => ({
  documentType: "SUPPLIER_BILL",
  amount: "1000.00",
  currency: "AUD",
  supplierContactIds: [SUP_A],
  accountIds: [ACC],
  projectIds: [],
  raisedByUserId: U1,
  ...over,
});

describe("approval policy matching", () => {
  it("amount band is [min, max): the boundaries land in exactly one tier", () => {
    const low = policy({ name: "Low", minAmount: null, maxAmount: "500.0000" });
    const mid = policy({ name: "Mid", minAmount: "500.0000", maxAmount: "5000.0000" });
    const high = policy({ name: "High", minAmount: "5000.0000", maxAmount: null });
    const all = [low, mid, high];
    const pick = (amount: string) => selectPolicy(all, facts({ amount }))?.name;
    expect(pick("0.00")).toBe("Low");
    expect(pick("499.99")).toBe("Low");
    expect(pick("499.9999")).toBe("Low");
    expect(pick("500.00")).toBe("Mid");
    expect(pick("4999.99")).toBe("Mid");
    expect(pick("5000.00")).toBe("High");
    expect(pick("5000.01")).toBe("High");
    expect(pick("1000000.00")).toBe("High");
  });

  it("compares decimals exactly, not as floats", () => {
    const p = policy({ minAmount: "0.3000", maxAmount: "0.6000" });
    expect(policyMatches(p, facts({ amount: "0.1" }))).toBe(false);
    expect(policyMatches(p, facts({ amount: "0.3" }))).toBe(true);
    expect(policyMatches(p, facts({ amount: "0.5999" }))).toBe(true);
    expect(policyMatches(p, facts({ amount: "0.6" }))).toBe(false);
  });

  it("first match by priority wins (lowest number), then oldest", () => {
    const broad = policy({ name: "Broad", priority: 200 });
    const narrow = policy({ name: "Narrow", priority: 10, minAmount: "500.0000" });
    expect(selectPolicy([broad, narrow], facts({ amount: "900" }))?.name).toBe("Narrow");
    expect(selectPolicy([broad, narrow], facts({ amount: "100" }))?.name).toBe("Broad");
    const older = policy({ name: "Older", priority: 50, createdAt: new Date(2020, 0, 1) });
    const newer = policy({ name: "Newer", priority: 50, createdAt: new Date(2025, 0, 1) });
    expect(selectPolicy([newer, older], facts())?.name).toBe("Older");
  });

  it("returns null when nothing matches, and ignores inactive policies and other document types", () => {
    expect(selectPolicy([], facts())).toBeNull();
    expect(selectPolicy([policy({ isActive: false })], facts())).toBeNull();
    expect(selectPolicy([policy({ documentType: "EXPENSE_CLAIM" })], facts())).toBeNull();
  });

  it("filters: supplier, account, project, raised-by user and currency", () => {
    expect(policyMatches(policy({ filters: { supplierContactIds: [SUP_A] } }), facts())).toBe(true);
    expect(policyMatches(policy({ filters: { supplierContactIds: [SUP_B] } }), facts())).toBe(false);
    expect(policyMatches(policy({ filters: { accountIds: [ACC] } }), facts())).toBe(true);
    expect(policyMatches(policy({ filters: { accountIds: [PRJ] } }), facts())).toBe(false);
    expect(policyMatches(policy({ filters: { projectIds: [PRJ] } }), facts())).toBe(false);
    expect(policyMatches(policy({ filters: { projectIds: [PRJ] } }), facts({ projectIds: [PRJ] }))).toBe(true);
    expect(policyMatches(policy({ filters: { userIds: [U1] } }), facts())).toBe(true);
    expect(policyMatches(policy({ filters: { userIds: [U2] } }), facts())).toBe(false);
    expect(policyMatches(policy({ filters: { userIds: [U1] } }), facts({ raisedByUserId: null }))).toBe(false);
    expect(policyMatches(policy({ filters: { currency: "USD" } }), facts())).toBe(false);
    expect(policyMatches(policy({ filters: { currency: "AUD" } }), facts())).toBe(true);
  });

  it("a multi-valued fact matches when ANY of its values is in the filter", () => {
    expect(policyMatches(policy({ filters: { accountIds: [PRJ, ACC] } }), facts({ accountIds: [U1, ACC] }))).toBe(true);
  });
});

describe("policy input validation", () => {
  const base = { name: "X", documentType: "SUPPLIER_BILL", steps: [{ name: "S", roles: ["ACCOUNTANT"] }] };
  it("accepts a minimal policy and applies defaults", () => {
    const parsed = policyInputSchema.parse(base);
    expect(parsed.priority).toBe(100);
    expect(parsed.steps[0]!.requiredApprovals).toBe(1);
    expect(parsed.allowSamePersonMultipleSteps).toBe(false);
  });
  it("rejects: no steps, empty step, bad band, unknown type, unknown role, non-decimal amount, too many steps", () => {
    expect(policyInputSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, steps: [{ name: "S" }] }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, minAmount: "10", maxAmount: "10" }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, minAmount: "10", maxAmount: "5" }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, documentType: "JOURNAL" }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, steps: [{ name: "S", roles: ["WIZARD"] }] }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, minAmount: "1e3" }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, minAmount: "-5" }).success).toBe(false);
    expect(policyInputSchema.safeParse({ ...base, steps: Array.from({ length: 7 }, () => ({ name: "S", roles: ["ACCOUNTANT"] })) }).success).toBe(false);
  });
});

describe("plain-English routing preview", () => {
  it("describes the matched tiers in order, and the no-policy case", () => {
    const tiers = [
      policy({ name: "Under 500", maxAmount: "500.0000", steps: [{ name: "Team manager", roles: ["MANAGER"], userIds: [], requiredApprovals: 1 }] }),
      policy({
        name: "Over 25k",
        minAmount: "25000.0000",
        steps: [
          { name: "Finance", roles: ["ACCOUNTANT"], userIds: [], requiredApprovals: 1 },
          { name: "Director", roles: ["OWNER"], userIds: [U2], requiredApprovals: 2 },
        ],
      }),
    ];
    const small = describeRouting(tiers, facts({ amount: "100" }));
    expect(small.matched?.name).toBe("Under 500");
    expect(small.text).toContain("Under 500");
    expect(small.text).toContain("a Manager");
    const big = describeRouting(tiers, facts({ amount: "30000" }), new Map([[U2, "Dana Director"]]));
    expect(big.steps).toHaveLength(2);
    expect(big.text).toContain("1. Finance");
    expect(big.text).toContain("2 approvals from Dana Director or an Owner");
    expect(big.text).toContain("nobody can satisfy two steps");
    const none = describeRouting(tiers, facts({ amount: "1000" }));
    expect(none.matched).toBeNull();
    expect(none.text).toContain("no approval policy");
  });
});

describe("decision-time eligibility (pure)", () => {
  const step = { id: "s1", requiredRoles: ["ACCOUNTANT"], requiredUserIds: [U2] };
  const base = {
    userId: U1,
    membershipRole: "ACCOUNTANT" as const,
    membershipActive: true,
    type: "SUPPLIER_BILL" as const,
    excludedUserIds: [] as string[],
    step,
    earlierApprovalStepIds: [] as string[],
    allowSamePersonMultipleSteps: false,
  };
  it("allows an active role holder with the native permission", () => {
    expect(evaluateEligibility(base)).toEqual({ ok: true, repeat: false });
  });
  it("refuses inactive members, excluded people, wrong role, and a role that lost the native permission", () => {
    expect(evaluateEligibility({ ...base, membershipActive: false }).ok).toBe(false);
    expect(evaluateEligibility({ ...base, membershipRole: null }).ok).toBe(false);
    expect(evaluateEligibility({ ...base, excludedUserIds: [U1] }).ok).toBe(false);
    expect(evaluateEligibility({ ...base, membershipRole: "MANAGER" }).ok).toBe(false);
    // BOOKKEEPER named explicitly by user id still cannot approve bills without supplier_bill:post semantic.
    const named = evaluateEligibility({ ...base, userId: U2, membershipRole: "READ_ONLY" });
    expect(named.ok).toBe(false);
  });
  it("a second step by the same person needs the explicit policy flag", () => {
    const again = { ...base, earlierApprovalStepIds: ["s0"] };
    expect(evaluateEligibility(again).ok).toBe(false);
    expect(evaluateEligibility({ ...again, allowSamePersonMultipleSteps: true })).toEqual({ ok: true, repeat: true });
    expect(evaluateEligibility({ ...again, earlierApprovalStepIds: ["s1"], allowSamePersonMultipleSteps: true }).ok).toBe(false);
  });
});
