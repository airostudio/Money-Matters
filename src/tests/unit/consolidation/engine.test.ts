import { describe, expect, it } from "vitest";
import { createAccountResolver } from "@/domain/consolidation/account-mapping";
import { buildConsolidatedBalanceSheet, buildConsolidatedProfitAndLoss } from "@/domain/consolidation/consolidate";
import { computeIntercompanyEliminations } from "@/domain/consolidation/eliminations";
import { MixedCurrencyError } from "@/domain/consolidation/errors";
import {
  MAX_ENTITIES_PER_GROUP,
  type ConsolidationConfig,
  type EntityLine,
  type EntityRef,
  type EntityStatement,
  type GroupAccountDef,
  type IntercompanyDef,
} from "@/domain/consolidation/types";
import { buildBalanceSheet } from "@/domain/reporting/financial-statements";
import { CURRENT_YEAR_EARNINGS_LABEL, RETAINED_EARNINGS_PRIOR_LABEL } from "@/domain/reporting/financial-statements";
import type { AccountType } from "@/domain/accounts/account-service";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";

const entity = (id: string, name: string, role: "PARENT" | "SUBSIDIARY" = "SUBSIDIARY"): EntityRef => ({
  organizationId: id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  currency: "AUD",
  role,
});

let seq = 0;
const line = (code: string, name: string, type: AccountType, amount: string, accountId = `acct-${code}-${++seq}`): EntityLine => ({
  accountId,
  code,
  name,
  type,
  amount,
});

const ga = (id: string, type: AccountType, code: string, name: string): GroupAccountDef => ({ id, type, code, name });

const GROUP_CHART: GroupAccountDef[] = [
  ga("g-cash", "ASSET", "1000", "Cash"),
  ga("g-icl", "ASSET", "1500", "Intercompany loan receivable"),
  ga("g-icr", "ASSET", "1400", "Intercompany receivable"),
  ga("g-ar", "ASSET", "1100", "Accounts receivable"),
  ga("g-icp", "LIABILITY", "2500", "Intercompany loan payable"),
  ga("g-icpay", "LIABILITY", "2400", "Intercompany payable"),
  ga("g-cap", "EQUITY", "3000", "Share capital"),
  ga("g-sales", "REVENUE", "4000", "Sales"),
  ga("g-icrev", "REVENUE", "4100", "Intercompany revenue"),
  ga("g-cogs", "EXPENSE", "5000", "Cost of sales"),
  ga("g-icexp", "EXPENSE", "6100", "Intercompany expense"),
];

const emptyConfig = (over: Partial<ConsolidationConfig> = {}): ConsolidationConfig => ({
  groupAccounts: GROUP_CHART,
  mappings: [],
  intercompany: [],
  adjustments: [],
  ...over,
});

/** Real single-entity BS lines, via the same builder ReportingService uses (so computed-line names cannot drift). */
function bsFrom(
  rows: Array<{ code: string; name: string; type: AccountType; debit: string; credit: string }>,
  priorProfit = "0",
  currentProfit = "0",
): EntityLine[] {
  const report = buildBalanceSheet(
    rows.map((r, i) => ({
      accountId: `acct-${r.code}`,
      code: r.code,
      name: r.name,
      type: r.type,
      subType: null,
      totalDebit: r.debit,
      totalCredit: r.credit,
    })),
    "AUD",
    { priorPeriods: priorProfit, currentYear: currentProfit },
  );
  const out: EntityLine[] = [];
  for (const l of report.assets) out.push({ accountId: l.accountId, code: l.code, name: l.name, type: "ASSET", amount: l.amount });
  for (const l of report.liabilities) out.push({ accountId: l.accountId, code: l.code, name: l.name, type: "LIABILITY", amount: l.amount });
  for (const l of report.equity)
    out.push({
      accountId: l.accountId,
      code: l.code,
      name: l.name,
      type: "EQUITY",
      amount: l.amount,
      computed: l.isComputed ? (l.name === CURRENT_YEAR_EARNINGS_LABEL ? "CURRENT_YEAR" : "RE_PRIOR") : undefined,
    });
  return out;
}

const loan = (org: string, counterparty: string, accountId: string, kind: IntercompanyDef["kind"], code: string): IntercompanyDef => ({
  organizationId: org,
  accountId,
  accountCode: code,
  accountName: code,
  kind,
  counterpartyOrganizationId: counterparty,
});

/** A lends B `lendA` (A's books) / B records `borrowB` (B's books); A has 50,000 cash after lending 10,000 from 60,000 capital. */
function loanScenario(borrowB: string) {
  const a: EntityStatement = {
    entity: entity(A, "Company A", "PARENT"),
    lines: bsFrom([
      { code: "1000", name: "Cash", type: "ASSET", debit: "50000", credit: "0" },
      { code: "1500", name: "Intercompany loan receivable", type: "ASSET", debit: "10000", credit: "0" },
      { code: "3000", name: "Share capital", type: "EQUITY", debit: "0", credit: "60000" },
    ]),
  };
  const b: EntityStatement = {
    entity: entity(B, "Company B"),
    lines: bsFrom([
      { code: "1000", name: "Cash", type: "ASSET", debit: borrowB, credit: "0" },
      { code: "2500", name: "Intercompany loan payable", type: "LIABILITY", debit: "0", credit: borrowB },
    ]),
  };
  const intercompany = [
    loan(A, B, "acct-1500", "LOAN_RECEIVABLE", "1500"),
    loan(B, A, "acct-2500", "LOAN_PAYABLE", "2500"),
  ];
  return { statements: [a, b], intercompany };
}

const asOf = new Date(Date.UTC(2026, 2, 31));

describe("account mapping", () => {
  const resolve = createAccountResolver(GROUP_CHART, [
    { organizationId: B, accountId: "b-sales", groupAccountId: "g-sales" },
    { organizationId: B, accountId: "b-wrongtype", groupAccountId: "g-cash" },
  ]);

  it("matches by the default rule: same type AND same code", () => {
    const r = resolve(A, { accountId: "x", code: "1000", type: "ASSET" });
    expect(r).toMatchObject({ kind: "MAPPED", via: "DEFAULT", groupAccount: { id: "g-cash" } });
  });

  it("does NOT match the same code with a different type", () => {
    // 1000 is a group ASSET; an EXPENSE account coded 1000 has no group account.
    expect(resolve(A, { accountId: "x", code: "1000", type: "EXPENSE" })).toEqual({ kind: "UNMAPPED" });
  });

  it("an explicit mapping overrides the default rule", () => {
    const r = resolve(B, { accountId: "b-sales", code: "4999", type: "REVENUE" });
    expect(r).toMatchObject({ kind: "MAPPED", via: "EXPLICIT", groupAccount: { id: "g-sales" } });
  });

  it("an explicit mapping across types is stale and falls to unmapped, not to the default", () => {
    expect(resolve(B, { accountId: "b-wrongtype", code: "1000", type: "LIABILITY" })).toEqual({ kind: "UNMAPPED" });
  });

  it("an unknown code is unmapped", () => {
    expect(resolve(A, { accountId: "x", code: "9999", type: "ASSET" })).toEqual({ kind: "UNMAPPED" });
  });
});

describe("intercompany loan: A lends B 10,000 (hand-verified)", () => {
  it("combined: assets 70,000 = liabilities 10,000 + equity 60,000; eliminated: 60,000 = 0 + 60,000", () => {
    const { statements, intercompany } = loanScenario("10000");
    const bs = buildConsolidatedBalanceSheet({ statements, config: emptyConfig({ intercompany }), asOf, currency: "AUD" });

    expect(bs.assets.totals.byEntity[A]).toBe("60000.0000");
    expect(bs.assets.totals.byEntity[B]).toBe("10000.0000");
    expect(bs.assets.totals.combined).toBe("70000.0000");
    expect(bs.liabilities.totals.combined).toBe("10000.0000");
    expect(bs.equity.totals.combined).toBe("60000.0000");

    // The elimination removes the loan from both sides, equally.
    expect(bs.assets.totals.eliminations).toBe("-10000.0000");
    expect(bs.liabilities.totals.eliminations).toBe("-10000.0000");
    expect(bs.equity.totals.eliminations).toBe("0.0000");

    expect(bs.assets.totals.consolidated).toBe("60000.0000");
    expect(bs.liabilities.totals.consolidated).toBe("0.0000");
    expect(bs.equity.totals.consolidated).toBe("60000.0000");
    expect(bs.isBalanced).toBe(true);
    expect(bs.isConsolidatedBalanced).toBe(true);

    // Consolidated cash line is 50,000 + 10,000 and the loan lines are gone.
    const cash = bs.assets.lines.find((l) => l.code === "1000")!;
    expect(cash.consolidated).toBe("60000.0000");
    expect(bs.assets.lines.find((l) => l.code === "1500")!.consolidated).toBe("0.0000");

    expect(bs.reconciliation).toHaveLength(1);
    expect(bs.reconciliation[0]).toMatchObject({ status: "MATCHED", matched: "10000.0000", difference: "0.0000", category: "LOAN" });
    expect(bs.eliminationEntries).toHaveLength(1);
    const e = bs.eliminationEntries[0]!;
    expect(e.amount).toBe("10000.0000");
    expect(e.lines.find((l) => l.side === "DEBIT")).toMatchObject({ organizationId: B, code: "2500" });
    expect(e.lines.find((l) => l.side === "CREDIT")).toMatchObject({ organizationId: A, code: "1500" });
  });

  it("a deliberately mismatched amount is reported, only the matched part is eliminated, and the sheet still balances", () => {
    const { statements, intercompany } = loanScenario("9000.5000");
    const bs = buildConsolidatedBalanceSheet({ statements, config: emptyConfig({ intercompany }), asOf, currency: "AUD" });

    expect(bs.reconciliation).toHaveLength(1);
    expect(bs.reconciliation[0]).toMatchObject({
      status: "MISMATCH",
      matched: "9000.5000",
      difference: "999.5000", // A says 10,000.00, B says 9,000.50
    });
    expect(bs.reconciliation[0]!.creditor).toMatchObject({ organizationId: A, amount: "10000.0000" });
    expect(bs.reconciliation[0]!.debtor).toMatchObject({ organizationId: B, amount: "9000.5000" });

    // 999.50 of A's receivable survives into the consolidated figures: NOT forced to zero.
    expect(bs.assets.lines.find((l) => l.code === "1500")!.consolidated).toBe("999.5000");
    expect(bs.liabilities.totals.consolidated).toBe("0.0000");
    // A cash 50,000 + residual 999.50 + B cash 9,000.50 - elimination 9,000.50 ... = 60,000
    expect(bs.assets.totals.consolidated).toBe("60000.0000");
    expect(bs.isBalanced).toBe(true);
  });

  it("a one-sided balance eliminates nothing and is reported", () => {
    const { statements, intercompany } = loanScenario("10000");
    const oneSided = intercompany.filter((d) => d.organizationId === A);
    const bs = buildConsolidatedBalanceSheet({ statements, config: emptyConfig({ intercompany: oneSided }), asOf, currency: "AUD" });

    expect(bs.reconciliation[0]).toMatchObject({ status: "ONE_SIDED", matched: "0.0000", difference: "10000.0000" });
    expect(bs.eliminationEntries).toHaveLength(0);
    expect(bs.assets.totals.eliminations).toBe("0.0000");
    // Nothing eliminated, so combined == consolidated and it still balances.
    expect(bs.assets.totals.consolidated).toBe("70000.0000");
    expect(bs.isBalanced).toBe(true);
  });

  it("reports a counterparty that is not part of the report without naming or touching it", () => {
    const { statements, intercompany } = loanScenario("10000");
    const onlyA = [statements[0]!]; // B excluded (no access)
    const bs = buildConsolidatedBalanceSheet({ statements: onlyA, config: emptyConfig({ intercompany }), asOf, currency: "AUD" });
    expect(bs.reconciliation).toHaveLength(1);
    expect(bs.reconciliation[0]).toMatchObject({ status: "COUNTERPARTY_UNAVAILABLE", matched: "0.0000", debtor: null });
    expect(JSON.stringify(bs)).not.toContain("Company B");
    // Nothing eliminated (the counterparty is not in the report), so the one entity's own sheet stands and balances.
    expect(bs.eliminationEntries).toHaveLength(0);
    expect(bs.isBalanced).toBe(true);
  });

  it("allocates a matched amount across several designated accounts in code order", () => {
    const a: EntityStatement = {
      entity: entity(A, "Company A", "PARENT"),
      lines: [line("1400", "IC trade rec", "ASSET", "300", "a-1400"), line("1410", "IC trade rec 2", "ASSET", "200", "a-1410")],
    };
    const b: EntityStatement = {
      entity: entity(B, "Company B"),
      lines: [line("2400", "IC trade pay", "LIABILITY", "400", "b-2400")],
    };
    const result = computeIntercompanyEliminations({
      categories: ["TRADE"],
      statements: [a, b],
      designations: [
        loan(A, B, "a-1400", "RECEIVABLE", "1400"),
        loan(A, B, "a-1410", "RECEIVABLE", "1410"),
        loan(B, A, "b-2400", "PAYABLE", "2400"),
      ],
      currency: "AUD",
    });
    expect(result.reconciliation[0]).toMatchObject({ matched: "400.0000", difference: "100.0000", status: "MISMATCH" });
    const reductions = result.reductions.filter((r) => r.organizationId === A).map((r) => [r.code, r.amount.toString()]);
    expect(reductions).toEqual([
      ["1400", "300.0000"],
      ["1410", "100.0000"],
    ]);
  });
});

describe("account mapping in a consolidated statement", () => {
  it("shows a per-entity column, a combined column, and puts unmapped accounts in an explicit bucket (never dropped or merged)", () => {
    const a: EntityStatement = {
      entity: entity(A, "Company A", "PARENT"),
      lines: [line("4000", "Sales", "REVENUE", "1000"), line("5000", "COGS", "EXPENSE", "400")],
    };
    const b: EntityStatement = {
      entity: entity(B, "Company B"),
      lines: [
        line("4000", "Revenue", "REVENUE", "250.25"),
        line("4777", "Odd income", "REVENUE", "50"), // no group account 4777
        line("5000", "Cost of goods", "EXPENSE", "100.10"),
      ],
    };
    const pl = buildConsolidatedProfitAndLoss({
      statements: [a, b],
      config: emptyConfig(),
      from: new Date(Date.UTC(2026, 0, 1)),
      to: asOf,
      currency: "AUD",
    });

    const sales = pl.revenue.lines.find((l) => l.code === "4000")!;
    expect(sales.byEntity[A]).toBe("1000.0000");
    expect(sales.byEntity[B]).toBe("250.2500");
    expect(sales.combined).toBe("1250.2500");
    expect(sales.consolidated).toBe("1250.2500");
    // Mapped by code+type, named by the GROUP account, with both entities' accounts as sources.
    expect(sales.name).toBe("Sales");
    expect(sales.sources).toHaveLength(2);

    const unmapped = pl.revenue.lines.find((l) => l.kind === "UNMAPPED")!;
    expect(unmapped.name).toBe("Unmapped revenue");
    expect(unmapped.consolidated).toBe("50.0000");
    expect(unmapped.sources[0]).toMatchObject({ organizationId: B, code: "4777", mapping: "UNMAPPED" });
    expect(pl.unmapped.count).toBe(1);

    // Nothing dropped: totals include the unmapped bucket.
    expect(pl.revenue.totals.consolidated).toBe("1300.2500");
    expect(pl.expenses.totals.consolidated).toBe("500.1000");
    expect(pl.netProfit.consolidated).toBe("800.1500");
    expect(pl.netProfit.byEntity[A]).toBe("600.0000");
    expect(pl.netProfit.byEntity[B]).toBe("200.1500");
  });

  it("an explicit mapping folds a differently-coded account into the group line", () => {
    const b: EntityStatement = { entity: entity(B, "Company B"), lines: [line("4777", "Odd income", "REVENUE", "50", "b-odd")] };
    const pl = buildConsolidatedProfitAndLoss({
      statements: [b],
      config: emptyConfig({ mappings: [{ organizationId: B, accountId: "b-odd", groupAccountId: "g-sales" }] }),
      from: new Date(Date.UTC(2026, 0, 1)),
      to: asOf,
      currency: "AUD",
    });
    expect(pl.unmapped.count).toBe(0);
    expect(pl.revenue.lines.find((l) => l.code === "4000")!.sources[0]).toMatchObject({ mapping: "EXPLICIT", code: "4777" });
  });
});

describe("consolidated Profit & Loss eliminations", () => {
  it("eliminates matched intercompany revenue against expense and leaves net profit unchanged", () => {
    const a: EntityStatement = {
      entity: entity(A, "Company A", "PARENT"),
      lines: [line("4000", "Sales", "REVENUE", "1000", "a-4000"), line("4100", "IC revenue", "REVENUE", "2500", "a-4100")],
    };
    const b: EntityStatement = {
      entity: entity(B, "Company B"),
      lines: [line("6100", "IC expense", "EXPENSE", "2500", "b-6100"), line("5000", "COGS", "EXPENSE", "300", "b-5000")],
    };
    const pl = buildConsolidatedProfitAndLoss({
      statements: [a, b],
      config: emptyConfig({ intercompany: [loan(A, B, "a-4100", "REVENUE", "4100"), loan(B, A, "b-6100", "EXPENSE", "6100")] }),
      from: new Date(Date.UTC(2026, 0, 1)),
      to: asOf,
      currency: "AUD",
    });
    expect(pl.revenue.totals.combined).toBe("3500.0000");
    expect(pl.expenses.totals.combined).toBe("2800.0000");
    expect(pl.netProfit.combined).toBe("700.0000");
    expect(pl.revenue.totals.eliminations).toBe("-2500.0000");
    expect(pl.expenses.totals.eliminations).toBe("-2500.0000");
    expect(pl.revenue.totals.consolidated).toBe("1000.0000");
    expect(pl.expenses.totals.consolidated).toBe("300.0000");
    expect(pl.netProfit.consolidated).toBe("700.0000");
    expect(pl.reconciliation[0]).toMatchObject({ category: "INCOME_EXPENSE", status: "MATCHED" });
  });
});

describe("exact decimal arithmetic", () => {
  it("sums amounts that would drift in floating point exactly", () => {
    const statements: EntityStatement[] = [A, B, C].map((id, i) => ({
      entity: entity(id, `E${i}`, i === 0 ? "PARENT" : "SUBSIDIARY"),
      lines: [line("4000", "Sales", "REVENUE", "0.1")],
    }));
    const pl = buildConsolidatedProfitAndLoss({ statements, config: emptyConfig(), from: new Date(0), to: asOf, currency: "AUD" });
    expect(pl.revenue.totals.consolidated).toBe("0.3000"); // 0.1 + 0.1 + 0.1 !== 0.3 in floats
  });

  it("eliminates a fractional matched amount exactly and the Balance Sheet balances to the cent", () => {
    const { statements, intercompany } = loanScenario("3333.3333");
    // A lent 10,000 but B only booked 3,333.3333 -> matched 3,333.3333, difference 6,666.6667
    const bs = buildConsolidatedBalanceSheet({ statements, config: emptyConfig({ intercompany }), asOf, currency: "AUD" });
    expect(bs.reconciliation[0]!.matched).toBe("3333.3333");
    expect(bs.reconciliation[0]!.difference).toBe("6666.6667");
    expect(bs.isBalanced).toBe(true);
  });
});

describe("manual consolidation adjustments", () => {
  const adjDate = new Date(Date.UTC(2026, 1, 1));

  it("a balanced adjustment on balance-sheet accounts moves the consolidated column and keeps it balanced", () => {
    const { statements } = loanScenario("10000");
    const bs = buildConsolidatedBalanceSheet({
      statements,
      config: emptyConfig({
        adjustments: [
          {
            id: "adj1",
            kind: "ADJUSTMENT",
            effectiveDate: adjDate,
            description: "Reclass cash to AR",
            reason: "test",
            reversesAdjustmentId: null,
            lines: [
              { groupAccountId: "g-ar", debit: "1000", credit: "0" },
              { groupAccountId: "g-cash", debit: "0", credit: "1000" },
            ],
          },
        ],
      }),
      asOf,
      currency: "AUD",
    });
    expect(bs.assets.totals.adjustments).toBe("0.0000");
    expect(bs.assets.lines.find((l) => l.code === "1100")!.adjustments).toBe("1000.0000");
    expect(bs.assets.lines.find((l) => l.code === "1000")!.adjustments).toBe("-1000.0000");
    expect(bs.isBalanced).toBe(true);
    expect(bs.adjustments).toHaveLength(1);
  });

  it("a P&L-account adjustment flows to current-year earnings and the sheet still balances", () => {
    const { statements } = loanScenario("10000");
    const bs = buildConsolidatedBalanceSheet({
      statements,
      config: emptyConfig({
        adjustments: [
          {
            id: "adj2",
            kind: "ADJUSTMENT",
            effectiveDate: adjDate,
            description: "Accrue consolidation expense",
            reason: "test",
            reversesAdjustmentId: null,
            // Dr Cost of sales 700 (expense), Cr Intercompany payable 700 (liability)
            lines: [
              { groupAccountId: "g-cogs", debit: "700", credit: "0" },
              { groupAccountId: "g-icpay", debit: "0", credit: "700" },
            ],
          },
        ],
      }),
      asOf,
      currency: "AUD",
    });
    const earnings = bs.equity.lines.find((l) => l.name === CURRENT_YEAR_EARNINGS_LABEL)!;
    expect(earnings.adjustments).toBe("-700.0000");
    expect(bs.liabilities.totals.adjustments).toBe("700.0000");
    expect(bs.difference.adjustments).toBe("0.0000");
    expect(bs.isBalanced).toBe(true);
  });

  it("a prior-year P&L adjustment goes to retained earnings (prior periods)", () => {
    const { statements } = loanScenario("10000");
    const bs = buildConsolidatedBalanceSheet({
      statements,
      config: emptyConfig({
        adjustments: [
          {
            id: "adj3",
            kind: "ADJUSTMENT",
            effectiveDate: new Date(Date.UTC(2025, 5, 30)),
            description: "Prior-year correction",
            reason: "test",
            reversesAdjustmentId: null,
            lines: [
              { groupAccountId: "g-ar", debit: "50", credit: "0" },
              { groupAccountId: "g-sales", debit: "0", credit: "50" },
            ],
          },
        ],
      }),
      asOf,
      currency: "AUD",
    });
    expect(bs.equity.lines.find((l) => l.name === RETAINED_EARNINGS_PRIOR_LABEL)!.adjustments).toBe("50.0000");
    expect(bs.isBalanced).toBe(true);
  });

  it("an adjustment dated after the report date is not applied", () => {
    const { statements } = loanScenario("10000");
    const bs = buildConsolidatedBalanceSheet({
      statements,
      config: emptyConfig({
        adjustments: [
          {
            id: "late",
            kind: "ADJUSTMENT",
            effectiveDate: new Date(Date.UTC(2026, 11, 31)),
            description: "later",
            reason: "test",
            reversesAdjustmentId: null,
            lines: [
              { groupAccountId: "g-ar", debit: "5", credit: "0" },
              { groupAccountId: "g-cash", debit: "0", credit: "5" },
            ],
          },
        ],
      }),
      asOf,
      currency: "AUD",
    });
    expect(bs.adjustments).toHaveLength(0);
  });

  it("a reversal nets the original to exactly zero", () => {
    const { statements } = loanScenario("10000");
    const lines = [
      { groupAccountId: "g-ar", debit: "123.4567", credit: "0" },
      { groupAccountId: "g-cash", debit: "0", credit: "123.4567" },
    ];
    const bs = buildConsolidatedBalanceSheet({
      statements,
      config: emptyConfig({
        adjustments: [
          { id: "o", kind: "ADJUSTMENT", effectiveDate: adjDate, description: "x", reason: "r", reversesAdjustmentId: null, lines },
          {
            id: "r",
            kind: "ADJUSTMENT",
            effectiveDate: adjDate,
            description: "Reversal",
            reason: "r",
            reversesAdjustmentId: "o",
            lines: lines.map((l) => ({ groupAccountId: l.groupAccountId, debit: l.credit, credit: l.debit })),
          },
        ],
      }),
      asOf,
      currency: "AUD",
    });
    expect(bs.assets.lines.find((l) => l.code === "1100")?.adjustments ?? "0.0000").toBe("0.0000");
    expect(bs.isBalanced).toBe(true);
  });
});

describe("limits and refusals", () => {
  it("caps a group at 10 entities", () => {
    expect(MAX_ENTITIES_PER_GROUP).toBe(10);
  });

  it("refuses mixed base currencies with a specific message, listing each currency", () => {
    const error = new MixedCurrencyError(["NZD", "AUD"]);
    expect(error.message).toContain("different base currencies: AUD, NZD");
    expect(error.message).toContain("currency translation is not yet supported");
    expect(error.currencies).toEqual(["AUD", "NZD"]);
  });
});
