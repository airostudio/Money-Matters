-- Seeds the two AU resident-individual tax/super rule sets this slice ships
-- with — see docs/roadmap.md's "Phase 8 Slice 1" section for the full
-- citation list this migration reproduces inline. These are the ONLY two
-- rows seeded; TaxRuleService.resolve() throws for any pay date outside
-- both ranges rather than silently extrapolating a rate.
--
-- Figures used here were supplied to this implementation already verified
-- against ato.gov.au and cross-checked against independent accounting-firm
-- sources (see the per-row source_citation column, reproduced from the
-- brief this slice was built from). The $4,020/$31,020/$51,370 FY2026-27
-- cumulative base figures that a hand calculation would derive from these
-- marginal rates/thresholds are NOT stored anywhere — see
-- payroll_tax_brackets' schema comment and
-- src/domain/payroll/bracket-calculations.ts, whose unit tests independently
-- reproduce them from the rows this migration inserts.

-- ---------------------------------------------------------------------------
-- FY2025-26 (1 July 2025 – 30 June 2026)
-- ---------------------------------------------------------------------------
WITH rs AS (
  INSERT INTO payroll_tax_rule_sets (
    jurisdiction, label, effective_from, effective_to,
    medicare_levy_rate, medicare_levy_lower_threshold, medicare_levy_upper_threshold,
    sg_rate, sg_quarterly_contribution_base_cap,
    requires_verification_note, source_citation
  ) VALUES (
    'AU', 'FY2025-26', '2025-07-01', '2026-06-30',
    '0.0200', '28011.0000', '35013.0000',
    '0.1200', '62500.0000',
    NULL,
    'ato.gov.au resident individual income tax rates FY2025-26; ato.gov.au "Super guarantee" page (12.00% rate, $62,500/quarter contribution base); ato.gov.au Medicare levy page (2.0% standard rate, $28,011/$35,013 singles low-income thresholds) — all cross-confirmed against independent accounting-firm sources per this slice''s brief.'
  )
  RETURNING id
)
INSERT INTO payroll_tax_brackets (rule_set_id, sequence, threshold, marginal_rate)
SELECT rs.id, b.seq, b.threshold, b.rate
FROM rs CROSS JOIN (VALUES
  (0, 0.0000::numeric,     0.0000::numeric),
  (1, 18200.0000::numeric, 0.1600::numeric),
  (2, 45000.0000::numeric, 0.3000::numeric),
  (3, 135000.0000::numeric,0.3700::numeric),
  (4, 190000.0000::numeric,0.4500::numeric)
) AS b(seq, threshold, rate);

-- ---------------------------------------------------------------------------
-- FY2026-27 (1 July 2026 – 30 June 2027) — the current financial year.
-- Only the 18,201-45,000 bracket's rate changed (16% -> 15%, legislated
-- "Personal income tax - new tax cuts"); all other brackets and the
-- Medicare levy are unchanged from FY2025-26.
--
-- sg_quarterly_contribution_base_cap is seeded with the SAME $62,500
-- quarterly figure and requires_verification_note is set (non-null) —
-- deliberately NOT null — because the ATO's move toward "Payday Super"
-- (SG calculated/paid per payday, with a $270,830 ANNUAL figure mentioned
-- in ATO material rather than a quarterly one) was not fully resolved
-- during this slice's research. This row keeps the stable, long-standing
-- quarterly-cadence mechanism at the unchanged 12% rate rather than
-- guessing at Payday Super's mechanics — see docs/roadmap.md and
-- src/domain/payroll/super-calculations.ts for the full caveat.
-- ---------------------------------------------------------------------------
WITH rs AS (
  INSERT INTO payroll_tax_rule_sets (
    jurisdiction, label, effective_from, effective_to,
    medicare_levy_rate, medicare_levy_lower_threshold, medicare_levy_upper_threshold,
    sg_rate, sg_quarterly_contribution_base_cap,
    requires_verification_note, source_citation
  ) VALUES (
    'AU', 'FY2026-27', '2026-07-01', '2027-06-30',
    '0.0200', '28011.0000', '35013.0000',
    '0.1200', '62500.0000',
    'UNRESOLVED: the ATO''s "Payday Super" reform (SG calculated/paid per payday rather than quarterly, with a $270,830 ANNUAL contribution-base figure mentioned in ATO material instead of a quarterly one) was not fully resolved during this slice''s research. This row applies the unchanged 12% SG rate with the FY2025-26 quarterly-cadence mechanism and quarterly cap as a deliberate, documented approximation — a registered tax agent or payroll provider MUST verify the correct FY2026-27 cadence/cap mechanics before this software is used for real FY2026-27 payroll. Also note: the PAYG withholding figures on this rule set use the annualized-bracket approximation method (see src/domain/payroll/payg-calculations.ts), not a byte-for-byte implementation of the ATO''s published NAT 1004 per-period lookup tables, which could not be independently fetched/verified during this research pass.',
    'ato.gov.au "Personal income tax - new tax cuts" legislation page (15% rate for the $18,201-$45,000 bracket from 1 July 2026, all other brackets unchanged from FY2025-26); medicare levy and SG rate carried over unchanged (no change identified for FY2026-27) — cumulative base amounts ($4,020/$31,020/$51,370) derived from these marginal rates/thresholds by src/domain/payroll/bracket-calculations.ts, not hardcoded here.'
  )
  RETURNING id
)
INSERT INTO payroll_tax_brackets (rule_set_id, sequence, threshold, marginal_rate)
SELECT rs.id, b.seq, b.threshold, b.rate
FROM rs CROSS JOIN (VALUES
  (0, 0.0000::numeric,     0.0000::numeric),
  (1, 18200.0000::numeric, 0.1500::numeric),
  (2, 45000.0000::numeric, 0.3000::numeric),
  (3, 135000.0000::numeric,0.3700::numeric),
  (4, 190000.0000::numeric,0.4500::numeric)
) AS b(seq, threshold, rate);
