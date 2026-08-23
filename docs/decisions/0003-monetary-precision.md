# 0003 — Decimal money, `Decimal(19,4)` columns, no floats

## Status
Accepted

## Context
Master spec §4/§87: never use binary floating point for money. The engine
must support fractional-cent accumulation correctness (e.g. tax
apportionment, multi-line allocations) without drift.

## Decision
- Database: every monetary column is `Decimal(19, 4)` (4 decimal places —
  enough headroom for tax/allocation rounding intermediate values beyond
  standard 2-decimal currencies, matches common ERP practice).
- Application: a `Money` value type (`src/domain/money/money.ts`) wraps
  `decimal.js`. All domain arithmetic goes through `Money`, never native
  `number` arithmetic on amounts. `Money.allocate(parts[])` implements
  largest-remainder-style allocation so split amounts always sum back
  exactly to the original (no lost/duplicated cents).
- Serialization boundary: API responses send amounts as decimal *strings*
  (e.g. `"1234.5000"`), not JS numbers, so no client-side float coercion
  can silently reintroduce imprecision. UI formatting (`Money`/currency
  display components) parses the string back into `Decimal` for display,
  never `parseFloat`.

## Consequences
- Slightly more verbose than `amount: number` everywhere, in exchange for
  the property-based tests in `docs/accounting-engine.md` §6 being able to
  assert exact equality rather than "close enough" tolerance checks — which
  is the actual bar for a ledger.
