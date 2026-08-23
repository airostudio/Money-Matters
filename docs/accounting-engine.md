# The Accounting Engine

This document specifies the double-entry posting engine implemented in
`src/domain/ledger/` and `src/domain/accounts/`. It is the most important
document in this repository: every other feature in the platform eventually
posts through this engine, so its invariants must hold unconditionally.

## 1. Non-negotiable invariants

1. **Every posted journal entry balances.** `SUM(line.debit) - SUM(line.credit) = 0`
   in the entry's base currency, exactly (Decimal, not float — see §4).
2. **A journal entry needs at least two lines.**
3. **Posted entries are immutable.** No UPDATE or DELETE is exposed on a
   posted `JournalEntry`/`JournalLine`. Corrections happen via:
   - **Reversal** — `PostingService.reverseEntry()` creates a new entry with
     every debit/credit swapped, linked to the original via `reversalOfId`.
   - **Adjusting entry** — a new, independent balanced entry.
4. **Closed periods reject new postings.** `FiscalPeriod.status` is one of
   `OPEN`, `SOFT_LOCKED`, `HARD_LOCKED`. Posting into a locked period is
   rejected unless the actor holds an override permission and the override
   is itself audit-logged with a reason (§41 of the master spec; full
   override workflow lands with Phase 9 close tooling — Phase 1 enforces the
   reject, not yet the override UI).
5. **Every account has exactly one normal balance side**, derived from its
   `AccountType` (see §2), and is used only to *sign* balances for display —
   it never changes how a debit/credit is recorded.
6. **Draft entries may be edited or deleted; posted entries may not.** This
   is the only lifecycle: `DRAFT → POSTED → (optionally) REVERSED`.
   `REVERSED` is a status *label*, not an exclusion flag: a reversed
   entry's lines remain permanent, immutable ledger history and stay in
   every balance calculation. Its financial effect is cancelled out only by
   its separate reversal entry's opposite postings (both entries net to
   zero together) — never by hiding the original. Balance/trial-balance
   queries therefore include every entry except `DRAFT` ones, which have no
   ledger effect at all.

## 2. Chart of Accounts model

`Account` fields: `code`, `name`, `type`, `subType`, `normalBalance`
(derived, not stored redundantly-editable), `currency`, `isControlAccount`,
`isSystemAccount`, `parentAccountId` (for hierarchical presentation),
`organizationId`.

`AccountType` (Phase 1 enum, extensible):

| Type      | Normal balance | Examples                          |
|-----------|---------------|------------------------------------|
| ASSET     | DEBIT         | Bank, Accounts Receivable, Inventory |
| LIABILITY | CREDIT        | Accounts Payable, GST Payable, Loans |
| EQUITY    | CREDIT        | Owner's Equity, Retained Earnings   |
| REVENUE   | CREDIT        | Sales, Interest Income              |
| EXPENSE   | DEBIT         | Cost of Goods Sold, Rent, Wages     |

System accounts (`isSystemAccount = true`, e.g. Retained Earnings,
Opening Balance Equity, Rounding) are seeded per-organization and cannot be
deleted, only deactivated.

## 3. Dimensions

Journal lines carry an optional set of `DimensionValue` references
(`JournalLineDimension` join table) rather than forcing a proliferation of
GL accounts per project/location/department (master spec §5). Phase 1 ships
the schema and the ability to tag a line with dimension values; dimensional
*reporting* (slicing P&L by dimension) is a Phase 5 (Reporting) feature.

## 4. Money, never floats

`src/domain/money/money.ts` wraps `decimal.js` (`Decimal`) behind a small
`Money` value type: `Money.of(amountString, currencyCode)`. Rules:

- No domain or persistence code represents a monetary amount as
  `number`/`float`. Prisma columns for money are `Decimal(19,4)`.
- `Money` arithmetic (`add`, `subtract`, `multiply`, `allocate`) always
  returns a new `Money`; there is no implicit float coercion anywhere in the
  call chain (enforced by an ESLint rule banning `parseFloat`/`Number()` on
  amount-shaped fields in `src/domain/**`, plus code review).
- Every journal line stores both **transaction currency** amount and **base
  currency** amount (`Money` + `exchangeRate` at time of posting), per master
  spec §31. For Phase 1 (AUD-only demo org) `exchangeRate` is always `1`,
  but the columns and the `Money` API do not special-case that — multi-
  currency is a Phase 9 feature that fills in `ExchangeRateService`, not a
  schema change.

## 5. Posting flow

```
PostingService.postJournal(actor, draft: JournalEntryDraft)
  1. assertPermission(actor, 'journal:post', org)
  2. assertPeriodOpen(draft.postingDate, org)
  3. validate: >= 2 lines, every line has an account in this org,
     every line has a non-zero debit XOR credit, all currencies known
  4. balance check: sum(debits) === sum(credits)  (Decimal equality)
  5. persist JournalEntry + JournalLines in one DB transaction, status POSTED
  6. AuditService.record('journal.posted', ...)
  7. return JournalPosted { entryId, ... }               (future: enqueue to outbox)
```

`reverseEntry(actor, entryId, reason)` follows the same shape: permission
check → period-open check → build mirrored lines → persist as a new POSTED
entry with `reversalOfId` set → mark the original `reversedById` → audit.

## 6. Testing strategy

- **Unit tests** (`src/tests/unit/ledger`): known-input/known-output cases —
  simple two-line entries, multi-line splits, rejection of unbalanced
  entries, rejection of single-line entries, rejection of postings into a
  locked period, reversal produces exactly mirrored signs.
- **Property-based tests** (`src/tests/property/ledger`, using `fast-check`):
  generate arbitrary *valid* journals (N random lines whose debits/credits
  are constructed to balance) and assert `postJournal` accepts them and the
  persisted `SUM(debit) = SUM(credit)`; generate arbitrary *invalid* journals
  (perturb one line's amount) and assert they are always rejected, never
  partially persisted.
- **Integration tests**: posting through the real Prisma-backed repository
  (test database), confirming the DB round-trip preserves Decimal precision
  exactly (no float drift) and that a failed validation leaves zero rows
  written (transactional integrity).

## 7. What Phase 1 explicitly defers

- Accruals/prepayments *automation* (recurring templates) — schema note only.
- Multi-currency revaluation — `ExchangeRateService` interface exists,
  implementation is a stub returning rate `1`.
- Period-lock override workflow UI — the reject path is enforced now; the
  "request override / approve override" workflow is Phase 9 (Close).
- Sub-ledger reconciliation to control accounts (AR/AP control account
  agreement) — enforced conceptually via `isControlAccount`, checked in
  Phase 3/4 when invoices/bills exist.
