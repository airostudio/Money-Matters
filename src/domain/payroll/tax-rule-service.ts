import { and, asc, desc, eq, lte, gte } from "drizzle-orm";
import { db } from "@/db/client";
import { payrollTaxBrackets, payrollTaxRuleSets } from "@/db/schema";
import { TaxRuleSetNotFoundError } from "./errors";
import type { TaxBracket } from "./bracket-calculations";
import type { SuperCadence } from "./payday-super";

export interface ResolvedTaxRuleSet {
  id: string;
  jurisdiction: string;
  label: string;
  /** Phase 8 Slice 4: new understanding of the same dates is a higher version, never an edit to a seeded row. */
  version: number;
  effectiveFrom: Date;
  effectiveTo: Date;
  medicareLevyRate: string;
  medicareLevyLowerThreshold: string;
  medicareLevyUpperThreshold: string;
  sgRate: string;
  /** `QUARTERLY` (legacy path) or `PAYDAY` (Payday Super). */
  sgCadence: SuperCadence;
  sgQuarterlyContributionBaseCap: string | null;
  /** The annual maximum contribution base of a `PAYDAY` rule set. */
  sgAnnualContributionBaseCap: string | null;
  requiresVerificationNote: string | null;
  sourceCitation: string;
  brackets: TaxBracket[];
  /** No tax-free threshold; empty for a rule set seeded without foreign resident rates. */
  foreignResidentBrackets: TaxBracket[];
}

export interface ResolveOptions {
  /** Phase 8 Slice 4(g): pick the version-1 quarterly SG path (the labelled LEGACY option) instead of the highest version. */
  legacyQuarterlySuper?: boolean;
}

type RuleSetRow = typeof payrollTaxRuleSets.$inferSelect;

async function hydrate(row: RuleSetRow): Promise<ResolvedTaxRuleSet> {
  const rows = await db
    .select()
    .from(payrollTaxBrackets)
    .where(eq(payrollTaxBrackets.ruleSetId, row.id))
    .orderBy(asc(payrollTaxBrackets.sequence));
  const toBracket = (b: (typeof rows)[number]): TaxBracket => ({
    sequence: b.sequence,
    threshold: b.threshold,
    marginalRate: b.marginalRate,
  });
  return {
    id: row.id,
    jurisdiction: row.jurisdiction,
    label: row.label,
    version: row.version,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    medicareLevyRate: row.medicareLevyRate,
    medicareLevyLowerThreshold: row.medicareLevyLowerThreshold,
    medicareLevyUpperThreshold: row.medicareLevyUpperThreshold,
    sgRate: row.sgRate,
    sgCadence: row.sgCadence === "PAYDAY" ? "PAYDAY" : "QUARTERLY",
    sgQuarterlyContributionBaseCap: row.sgQuarterlyContributionBaseCap,
    sgAnnualContributionBaseCap: row.sgAnnualContributionBaseCap,
    requiresVerificationNote: row.requiresVerificationNote,
    sourceCitation: row.sourceCitation,
    brackets: rows.filter((b) => b.category === "RESIDENT").map(toBracket),
    foreignResidentBrackets: rows.filter((b) => b.category === "FOREIGN_RESIDENT").map(toBracket),
  };
}

/**
 * Resolves the jurisdiction/effective-date-controlled tax/super rule set
 * for a given pay date — master spec §26's architecture principle, built
 * here for AU only (this slice's scope). `payroll_tax_rule_sets` is NOT
 * organization-scoped (it is shared regulatory reference data — see that
 * table's schema comment), so this reads the shared `db` client directly
 * rather than going through `withTenant`, exactly like any other
 * non-tenant lookup table in this codebase.
 *
 * Throws `TaxRuleSetNotFoundError` for any date outside every seeded rule
 * set's [effectiveFrom, effectiveTo] range — this is deliberate: a pay run
 * for a date this software doesn't have verified regulatory figures for
 * must fail loudly, never silently reuse the nearest year's numbers.
 *
 * Several versions may cover one date (Phase 8 Slice 4): the HIGHEST is used,
 * unless `legacyQuarterlySuper` asks for version 1.
 */
export const TaxRuleService = {
  async resolve(jurisdiction: string, payDate: Date, options: ResolveOptions = {}): Promise<ResolvedTaxRuleSet> {
    const [row] = await db
      .select()
      .from(payrollTaxRuleSets)
      .where(
        and(
          eq(payrollTaxRuleSets.jurisdiction, jurisdiction),
          lte(payrollTaxRuleSets.effectiveFrom, payDate),
          gte(payrollTaxRuleSets.effectiveTo, payDate),
          options.legacyQuarterlySuper ? eq(payrollTaxRuleSets.sgCadence, "QUARTERLY") : undefined,
        ),
      )
      .orderBy(options.legacyQuarterlySuper ? asc(payrollTaxRuleSets.version) : desc(payrollTaxRuleSets.version))
      .limit(1);
    if (!row) throw new TaxRuleSetNotFoundError(jurisdiction, payDate);
    return hydrate(row);
  },

  async list(jurisdiction: string): Promise<ResolvedTaxRuleSet[]> {
    const rows = await db
      .select()
      .from(payrollTaxRuleSets)
      .where(eq(payrollTaxRuleSets.jurisdiction, jurisdiction))
      .orderBy(asc(payrollTaxRuleSets.effectiveFrom), asc(payrollTaxRuleSets.version));
    const results: ResolvedTaxRuleSet[] = [];
    for (const row of rows) results.push(await hydrate(row));
    return results;
  },
};
