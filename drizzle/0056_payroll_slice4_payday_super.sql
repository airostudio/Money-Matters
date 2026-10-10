-- Phase 8 Slice 4: (g) Payday Super mechanics for FY2026-27 and (c) foreign resident rates.
--
-- Seeded rows from 0029 are NOT edited. The original FY2026-27 row stays as version 1 (the labelled LEGACY quarterly
-- path); this migration adds version 2 with the verified per-payday cadence and the annual contribution base. The resolver
-- picks the highest version covering a pay date unless a caller explicitly asks for the legacy quarterly path.
-- Foreign resident brackets are ADDED as new child rows (category FOREIGN_RESIDENT) of each rule set; no existing value
-- changes.
ALTER TABLE "payroll_tax_rule_sets" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_tax_rule_sets" ADD COLUMN "sg_cadence" text DEFAULT 'QUARTERLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_tax_rule_sets" ADD COLUMN "sg_annual_contribution_base_cap" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "payroll_tax_rule_sets" ADD CONSTRAINT "payroll_tax_rule_sets_cadence_check" CHECK ("payroll_tax_rule_sets"."sg_cadence" IN ('QUARTERLY', 'PAYDAY'));--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_tax_rule_sets_range_version_unique" ON "payroll_tax_rule_sets" USING btree ("jurisdiction","effective_from","version");--> statement-breakpoint
ALTER TABLE "payroll_tax_brackets" ADD COLUMN "category" text DEFAULT 'RESIDENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_tax_brackets" ADD CONSTRAINT "payroll_tax_brackets_category_check" CHECK ("payroll_tax_brackets"."category" IN ('RESIDENT', 'FOREIGN_RESIDENT'));--> statement-breakpoint
DROP INDEX "payroll_tax_brackets_rule_set_sequence_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_tax_brackets_rule_set_category_sequence_unique" ON "payroll_tax_brackets" USING btree ("rule_set_id","category","sequence");--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "tax_residency" text DEFAULT 'RESIDENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tax_residency_check" CHECK ("employees"."tax_residency" IN ('RESIDENT', 'FOREIGN_RESIDENT'));--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD COLUMN "super_cadence" text DEFAULT 'QUARTERLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_run_lines" ADD COLUMN "super_safe_by_date" timestamp with time zone;--> statement-breakpoint
WITH rs AS (
  INSERT INTO payroll_tax_rule_sets (
    jurisdiction, label, effective_from, effective_to,
    medicare_levy_rate, medicare_levy_lower_threshold, medicare_levy_upper_threshold,
    sg_rate, sg_quarterly_contribution_base_cap, sg_cadence, sg_annual_contribution_base_cap, version,
    requires_verification_note, source_citation
  )
  SELECT
    jurisdiction, 'FY2026-27 (Payday Super)', effective_from, effective_to,
    medicare_levy_rate, medicare_levy_lower_threshold, medicare_levy_upper_threshold,
    '0.1200', NULL, 'PAYDAY', '270830.0000', 2,
    'Still needs a registered tax agent / payroll provider: (1) the 2026-27 Medicare levy low-income thresholds had NOT been published when this row was written, so the 2025-26 singles thresholds ($28,011 / $35,013) are carried over unchanged; (2) the "safe-by" date for each payday''s super is a conservative weekday-only count that does not know public holidays, does not model clearing-house time, and is not the legal deadline; (3) qualifying earnings = ordinary time earnings here: commissions and salary-sacrificed super are not modelled; (4) new-employee / stapled-fund first-contribution timing is not modelled; (5) PAYG withholding still uses the annualised-bracket approximation, not the ATO NAT 1004 per-period tables.',
    'Payday Super: ATO "ATO calls on employers to prepare for Payday Super" and "Payment deadlines for Payday Super" (ato.gov.au), SmartCompany "Payday super legislation passes Parliament; new system to start July 1, 2026", Alvarez & Marsal "Payday Super Bills Received Royal Assent and Start Date Remains 1 July 2026", RSM, BDO and Clayton Utz (start 1 July 2026; contributions received by the fund within 7 business days of the qualifying earnings day, generally payday; business day = not a weekend or a whole-state public holiday in any Australian state or territory). Qualifying earnings = OTE plus commissions plus salary-sacrificed super: REST, taxbne.com.au, AustralianSuper. Maximum contribution base $270,830 for 2026-27 (concessional cap $32,500 x 100 / 12; maximum compulsory SG $32,499.60), annual rather than quarterly: ATO "Maximum contribution base" page as seen in search results, REST, AustralianSuper, taxbne.com.au. SG rate 12%: ATO. Tax brackets and Medicare levy carried unchanged from the version 1 FY2026-27 row.'
  FROM payroll_tax_rule_sets
  WHERE jurisdiction = 'AU' AND label = 'FY2026-27' AND version = 1
  RETURNING id
)
INSERT INTO payroll_tax_brackets (rule_set_id, sequence, threshold, marginal_rate, category)
SELECT rs.id, b.sequence, b.threshold, b.marginal_rate, 'RESIDENT'
FROM rs
CROSS JOIN payroll_tax_brackets b
JOIN payroll_tax_rule_sets v1 ON v1.id = b.rule_set_id AND v1.jurisdiction = 'AU' AND v1.label = 'FY2026-27' AND v1.version = 1
WHERE b.category = 'RESIDENT';--> statement-breakpoint
-- Foreign resident annual rates: 30% from the first dollar to $135,000, 37% to $190,000, 45% above (ATO "About foreign
-- resident tax rates"; ozcalc.com.au; austax.tools; taxbne.com.au - unchanged for 2025-26 and 2026-27; no Medicare levy).
INSERT INTO payroll_tax_brackets (rule_set_id, sequence, threshold, marginal_rate, category)
SELECT rs.id, v.sequence, v.threshold, v.marginal_rate, 'FOREIGN_RESIDENT'
FROM payroll_tax_rule_sets rs
CROSS JOIN (VALUES
  (0, 0.0000::numeric,      0.3000::numeric),
  (1, 135000.0000::numeric, 0.3700::numeric),
  (2, 190000.0000::numeric, 0.4500::numeric)
) AS v(sequence, threshold, marginal_rate)
WHERE rs.jurisdiction = 'AU';
