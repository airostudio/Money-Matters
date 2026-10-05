import type {
  ConsolidatedBalanceSheet,
  ConsolidatedCash,
  ConsolidatedProfitAndLoss,
  ConsolidatedReport,
  ConsolidationMeta,
  IntercompanyReconciliationRow,
} from "./types";

/**
 * Plain-text renderings of consolidated reports for the AI Financial
 * Controller's `consolidated_report` tool. They are built ONLY from an
 * already-computed `ConsolidatedReport` — i.e. from entities that passed their
 * own per-entity permission check — so the text can contain nothing about an
 * excluded entity beyond the count in the exclusion notice. Names of excluded
 * entities are deliberately never rendered here, even ones the user happens to
 * know.
 */

function header(meta: ConsolidationMeta, entityNames: string[]): string {
  const included = entityNames.length > 0 ? entityNames.join(", ") : "none";
  const lines = [`Entity group "${meta.group.name}". Entities included: ${included}.`];
  if (meta.exclusions.notice) {
    lines.push(
      `NOTICE: ${meta.exclusions.notice}. The figures below cover only the entities this user can access; do not estimate or describe the excluded ones.`,
    );
  }
  if (meta.deselectedCount > 0) {
    lines.push(`${meta.deselectedCount} group member(s) are switched off in the group's own settings and are not included.`);
  }
  return lines.join("\n");
}

function reconciliationText(rows: IntercompanyReconciliationRow[]): string[] {
  const exceptions = rows.filter((r) => r.status !== "MATCHED");
  if (exceptions.length === 0) return rows.length ? ["Intercompany balances: all matched and eliminated."] : [];
  return [
    `Intercompany reconciliation exceptions (${exceptions.length}) — the unmatched part stays in the consolidated figures:`,
    ...exceptions.map((r) => {
      const c = r.creditor ? `${r.creditor.name} books ${r.creditor.amount}` : "creditor side not available";
      const d = r.debtor ? `${r.debtor.name} books ${r.debtor.amount}` : "debtor side not available";
      return `  - ${r.category.replace("_", "/").toLowerCase()}: ${c}; ${d}; difference ${r.difference}; eliminated ${r.matched} (${r.status}).`;
    }),
  ];
}

export const consolidatedSummary = {
  profitAndLoss(report: ConsolidatedReport<ConsolidatedProfitAndLoss>, periodLabel: string): string {
    const byName = new Map(report.entities.map((e) => [e.organizationId, e.name]));
    const perEntity = report.entities.map((e) => `${e.name}: ${report.netProfit.byEntity[e.organizationId]}`);
    return [
      `Consolidated Profit & Loss for ${periodLabel} (${report.currency}).`,
      header(report, [...byName.values()]),
      `Revenue: combined ${report.revenue.totals.combined}, eliminations ${report.revenue.totals.eliminations}, adjustments ${report.revenue.totals.adjustments}, CONSOLIDATED ${report.revenue.totals.consolidated}.`,
      `Expenses: combined ${report.expenses.totals.combined}, eliminations ${report.expenses.totals.eliminations}, adjustments ${report.expenses.totals.adjustments}, CONSOLIDATED ${report.expenses.totals.consolidated}.`,
      `Net profit: CONSOLIDATED ${report.netProfit.consolidated} (combined before eliminations ${report.netProfit.combined}).`,
      `Net profit by entity: ${perEntity.join("; ") || "none"}.`,
      ...(report.unmapped.count > 0 ? [`${report.unmapped.count} line(s) are in the "Unmapped" bucket (accounts not yet mapped to the group chart); they are included in the totals.`] : []),
      ...reconciliationText(report.reconciliation),
    ].join("\n");
  },

  balanceSheet(report: ConsolidatedReport<ConsolidatedBalanceSheet>, dateLabel: string): string {
    return [
      `Consolidated Balance Sheet as of ${dateLabel} (${report.currency}).`,
      header(report, report.entities.map((e) => e.name)),
      `Total assets: combined ${report.assets.totals.combined}, eliminations ${report.assets.totals.eliminations}, CONSOLIDATED ${report.assets.totals.consolidated}.`,
      `Total liabilities: combined ${report.liabilities.totals.combined}, eliminations ${report.liabilities.totals.eliminations}, CONSOLIDATED ${report.liabilities.totals.consolidated}.`,
      `Total equity: combined ${report.equity.totals.combined}, eliminations ${report.equity.totals.eliminations}, CONSOLIDATED ${report.equity.totals.consolidated}.`,
      report.isBalanced
        ? "The sheet balances (Assets = Liabilities + Equity) in every column, before and after eliminations."
        : `WARNING: the sheet does not balance — consolidated difference ${report.difference.consolidated}.`,
      ...(report.unmapped.count > 0 ? [`${report.unmapped.count} line(s) are in the "Unmapped" bucket; they are included in the totals.`] : []),
      ...reconciliationText(report.reconciliation),
    ].join("\n");
  },

  cash(report: ConsolidatedReport<ConsolidatedCash>, dateLabel: string): string {
    return [
      `Consolidated cash position as of ${dateLabel} (${report.currency}).`,
      header(report, report.entities.map((e) => e.name)),
      `Total cash across the included entities: ${report.total}.`,
      ...report.entities.map((e) => `  - ${e.name}: ${e.total}`),
    ].join("\n");
  },
};
