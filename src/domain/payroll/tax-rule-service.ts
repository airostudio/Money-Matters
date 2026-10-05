import { and, asc, eq, lte, gte } from "drizzle-orm";
import { db } from "@/db/client";
import { payrollTaxBrackets, payrollTaxRuleSets } from "@/db/schema";
import { TaxRuleSetNotFoundError } from "./errors";
import type { TaxBracket } from "./bracket-calculations";

export interface ResolvedTaxRuleSet {
  id: string;
  jurisdiction: string;
  label: string;
  effectiveFrom: Date;
  effectiveTo: Date;
  medicareLevyRate: string;
  medicareLevyLowerThreshold: string;
  medicareLevyUpperThreshold: string;
  sgRate: string;
  sgQuarterlyContributionBaseCap: string | null;
  requiresVerificationNote: string | null;
  sourceCitation: string;
  brackets: TaxBracket[];
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
 */
export const TaxRuleService = {
  async resolve(jurisdiction: string, payDate: Date): Promise<ResolvedTaxRuleSet> {
    const [row] = await db
      .select()
      .from(payrollTaxRuleSets)
      .where(
        and(
          eq(payrollTaxRuleSets.jurisdiction, jurisdiction),
          lte(payrollTaxRuleSets.effectiveFrom, payDate),
          gte(payrollTaxRuleSets.effectiveTo, payDate),
        ),
      );
    if (!row) throw new TaxRuleSetNotFoundError(jurisdiction, payDate);

    const brackets = await db
      .select()
      .from(payrollTaxBrackets)
      .where(eq(payrollTaxBrackets.ruleSetId, row.id))
      .orderBy(asc(payrollTaxBrackets.sequence));

    return {
      id: row.id,
      jurisdiction: row.jurisdiction,
      label: row.label,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      medicareLevyRate: row.medicareLevyRate,
      medicareLevyLowerThreshold: row.medicareLevyLowerThreshold,
      medicareLevyUpperThreshold: row.medicareLevyUpperThreshold,
      sgRate: row.sgRate,
      sgQuarterlyContributionBaseCap: row.sgQuarterlyContributionBaseCap,
      requiresVerificationNote: row.requiresVerificationNote,
      sourceCitation: row.sourceCitation,
      brackets: brackets.map((b) => ({
        sequence: b.sequence,
        threshold: b.threshold,
        marginalRate: b.marginalRate,
      })),
    };
  },

  async list(jurisdiction: string): Promise<ResolvedTaxRuleSet[]> {
    const rows = await db
      .select()
      .from(payrollTaxRuleSets)
      .where(eq(payrollTaxRuleSets.jurisdiction, jurisdiction))
      .orderBy(asc(payrollTaxRuleSets.effectiveFrom));
    const results: ResolvedTaxRuleSet[] = [];
    for (const row of rows) {
      const brackets = await db
        .select()
        .from(payrollTaxBrackets)
        .where(eq(payrollTaxBrackets.ruleSetId, row.id))
        .orderBy(asc(payrollTaxBrackets.sequence));
      results.push({
        id: row.id,
        jurisdiction: row.jurisdiction,
        label: row.label,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        medicareLevyRate: row.medicareLevyRate,
        medicareLevyLowerThreshold: row.medicareLevyLowerThreshold,
        medicareLevyUpperThreshold: row.medicareLevyUpperThreshold,
        sgRate: row.sgRate,
        sgQuarterlyContributionBaseCap: row.sgQuarterlyContributionBaseCap,
        requiresVerificationNote: row.requiresVerificationNote,
        sourceCitation: row.sourceCitation,
        brackets: brackets.map((b) => ({ sequence: b.sequence, threshold: b.threshold, marginalRate: b.marginalRate })),
      });
    }
    return results;
  },
};
