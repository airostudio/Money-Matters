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

- Accruals/prepayments *automation* (recurring journal templates) — schema
  note only. Not to be confused with Phase 3 Slice 2's
  `recurring_invoice_templates` (`src/domain/sales/recurring-invoice-service.ts`)
  or Phase 4 Slice 2's `recurring_bill_templates`
  (`src/domain/purchases/recurring-bill-service.ts`), which generate draft
  *sales invoices*/*supplier bills* on a schedule via
  `InvoiceService.create`/`BillService.create`, not recurring GL journal
  entries — this deferral is still open.
- Multi-currency revaluation — `ExchangeRateService` interface exists,
  implementation is a stub returning rate `1`.
- Period-lock override workflow UI — the reject path is enforced now; the
  "request override / approve override" workflow is Phase 9 (Close).
- Sub-ledger reconciliation to control accounts — implemented for AR in
  Phase 3 Slice 1 (`src/domain/sales/invoice-service.ts`,
  `src/domain/sales/payment-service.ts`) and for AP in Phase 4 Slice 1
  (`src/domain/purchases/bill-service.ts`,
  `src/domain/purchases/supplier-payment-service.ts`): every invoice/bill
  and payment posting goes through this same `PostingService`, so an
  invoice's AR (or a bill's AP) control account balance is always exactly
  the sum of its own postings, never a parallel ledger.

## 8. Phase 5 Slice 1 — financial statements

`src/domain/reporting/` implements the P&L, Balance Sheet, and Cash Flow
Statement on top of everything above, read-only — no report ever writes to
the ledger. Two conventions this slice establishes, both load-bearing for
correctness and worth understanding before touching that code:

### 8a. Shared GL aggregation

`src/domain/ledger/gl-aggregation.ts`'s `sumPostedActivityByAccount(tx, orgId,
{ from?, to })` is the one query behind the Trial Balance
(`LedgerService.getTrialBalance`, `{ to: asOf }`) and every financial
statement: P&L sums a bounded `{ from, to }` period, Balance Sheet sums
`{ to: asOf }` (since account inception), and Cash Flow calls it three times
(the period itself, plus `{ to }` snapshots immediately before and at the
end of the period, to diff every non-cash balance-sheet account's movement).
Extracting this once — rather than four near-duplicate queries — means a
future dimension filter (master spec §4; `journal_line_dimensions` already
exists in the schema, unused by reporting yet) is one more `and(...)` clause
here, not a rewrite across every report.

### 8b. Retained Earnings without a close process

There is still no period-close step anywhere in this codebase (Phase 9's
"month-end close workspace" is what will eventually zero REVENUE/EXPENSE
account balances into the ledger's actual "Retained Earnings" system account
from `OrganizationService.STARTER_SYSTEM_ACCOUNTS`). Until that exists, a
Balance Sheet can only balance (Assets = Liabilities + Equity) by adding
**computed** equity lines for accumulated net profit — the extended
accounting equation `Assets = Liabilities + Equity + (Revenue − Expenses)`,
which holds by construction from the ledger's own debit=credit invariant
(§1 above) with zero extra assumptions. `buildBalanceSheet` in
`src/domain/reporting/financial-statements.ts` adds two such lines:
**"Retained Earnings (prior periods)"** (cumulative net profit from before
the current fiscal year) and **"Current Year Earnings"** (net profit from
the fiscal year's start through the report date) — the same split real
accounting software shows, so a later formal close naturally folds "prior
periods" into the real Retained Earnings account without changing this
report's shape. The fiscal year is treated as the **calendar year** for this
split (`ReportingService`'s `getRetainedEarningsSplit`) — there is no
organization-level "fiscal year start month" setting anywhere in the schema
today (only ad hoc `fiscal_periods` rows), and inventing one wasn't in scope
for this slice; a configurable fiscal year start belongs with Phase 9's
close workflow, at which point this function's `fiscalYearStart` becomes a
lookup instead of a `Date.UTC(year, 0, 1)` literal.

### 8c. Cash Flow Statement — indirect method, and why

The Cash Flow Statement uses the **indirect method**: start from Net Profit
(the P&L's own figure for the period) and adjust for the period's change in
every non-cash balance-sheet account, classified Operating/Investing/
Financing (`classifyNonCashAccount` in `financial-statements.ts`). The
**direct method** (categorizing each individual cash receipt/payment by
activity) was not built because this codebase has no transaction-level
cash-vs-non-cash tagging — every posting path (invoices, bills, expense
claims, bank reconciliation) would need retrofitting to record "was this a
cash movement, and for what activity" per line, which is a materially larger
change than a Phase 5 Slice 1 reporting feature justifies. The indirect
method needs nothing new: it's balance-sheet arithmetic the ledger already
supports.

**Cash accounts** are identified via `bank_accounts.glAccountId` — the same
explicit link the banking module (Phase 2) already uses to mean "this ASSET
account is a real bank account" — never a free-text `subType` guess. An
account not linked from `bank_accounts` is treated as non-cash regardless of
its name.

**Classification** of every other non-cash ASSET/LIABILITY/EQUITY account
uses `subType` (free text, not an enum — see §2): EQUITY is always
Financing; a LIABILITY tagged `"Non-current Liability"` (the onboarding
chart-of-accounts template's convention for loans) is Financing, every other
liability is Operating; an ASSET tagged `"Fixed Asset"` is Investing, every
other non-cash asset is Operating. An account with no subtype set defaults
to Operating, the standard indirect-method treatment for an untagged
working-capital item.

**The correctness guarantee**: from `Assets = Liabilities + Equity +
(Revenue − Expenses)` holding at both the start and end of a period,
`Cash = Liabilities + Equity + NetProfit − NonCashAssets`, so `ΔCash =
NetProfit + ΔLiabilities + ΔEquity − ΔNonCashAssets` — exactly what
`buildCashFlowStatement` computes, bucketed by classification. This means
the statement's own `reconciles` field (computed ending cash vs. the cash
accounts' actual ledger balance) is guaranteed `true` for any correctly
posted ledger, regardless of how accounts are classified into Operating/
Investing/Financing — classification only changes which section a movement
appears under, never the total. A `false` would mean a bug in this layer,
not a real accounting discrepancy (there is no other way to reach it, since
every posting goes through the balanced `PostingService`). See
`src/tests/integration/reporting/financial-statements.test.ts` and
`src/tests/property/reporting/balance-sheet-invariant.property.test.ts` for
this proven end-to-end against a real Postgres instance.

### 8d. Drill-down (master spec §32)

Every report line links to `/[orgSlug]/accounting/accounts/[accountId]/transactions`
(`ReportingService.getAccountTransactions`), which lists that account's
posted lines in the requested range and resolves each one's source document
by reverse-lookup: `invoices`, `bills`, `supplier_credit_notes`,
`expense_claims`, `payments`, and `supplier_payments` each carry a
`journalEntryId` set once by their own approval/posting step, so
`resolveSourceDocument` just checks each table for a match — no new link
column. `CUSTOMER_PAYMENT`/`SUPPLIER_PAYMENT` don't yet have a dedicated
detail page (a payment is shown inline on its invoice/bill's page today), so
those resolve without a link, just a label. The Journal Entry detail page
(`/accounting/journals/[entryId]`) shows the same source-document link via
`ReportingService.getSourceDocumentForJournalEntry`, reachable independently
of any report. Both the account-transactions drill-down and the Journal
Entry page are gated on `journal:read` (the existing, broadly-held
permission Trial Balance and Journals already use), not the new, stricter
`financial_report:read` — browsing one account's own postings isn't more
sensitive than the Journals list every `journal:read` holder can already
see; it's the *aggregate* P&L/Balance Sheet/Cash Flow views that reveal
overall profitability/position and get the stricter gate. See
`docs/roadmap.md`'s Phase 5 Slice 1 section for the exact permission
grant.
