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
4. **Locked periods reject new postings — inside the posting transaction.**
   `FiscalPeriod.status` is a **lock level**: `OPEN < SOFT_LOCKED <
   ADVISOR_LOCKED < TAX_LOCKED < HARD_LOCKED` (§15 has the exact model, the
   permission matrix, the override and reopen semantics, and how the legacy
   `SOFT_LOCKED`/`HARD_LOCKED` rows were migrated). The check is one query
   against `fiscal_periods` made by `PostingService` in the same database
   transaction as the insert, before anything is written, so a rejected
   posting leaves no rows behind. The only ways through a lock are an
   authorised, audited inline override of a SOFT (or an accountant's posting
   into an ADVISOR) lock, or the audited reopen workflow — never an edit of
   posted history.
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
- ~~Period-lock override workflow UI~~ — built in Phase 9 Slice 3 (§15).
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

## 9. Phase 7 Slice 1 — project profitability (Estimated vs. Actual)

`src/domain/projects/profitability-service.ts` sums every ledger-backed
line attributed to a project — `invoice_lines`/`bill_lines`/
`expense_claim_lines` filtered on their new `projectId` column (see
`docs/database.md` §2i for why that's a dedicated FK, not the dimension
system) — but **only for lines whose parent document has actually posted**
(not `DRAFT`, not `VOID`), the same "has a real ledger effect" rule
`sumPostedActivityByAccount` applies to journal entries, just expressed
against each document's own `status` column instead of walking through to
journal entries directly. This is why a DRAFT invoice generated from
unbilled time contributes nothing to Actual Revenue until a human
separately approves and posts it (§1's "every mutation goes through
`PostingService`" invariant, carried through here as "Actual numbers only
ever reflect what actually posted").

`src/domain/projects/profitability-calculations.ts`'s `computeProjectVariance`
is the pure, DB-free arithmetic — Money-safe division for margin (a null
margin on zero revenue, never a fabricated zero or a division-by-zero
crash), a signed variance, and a plain-language explanation per line,
extensible to a labelled cost-category breakdown (master spec §22's
"Labour exceeded estimate by $3,200" example). It is unit-tested directly,
independent of the database.

**Honest scope cut**: Actual Cost does not include a dollar figure for
logged labour. This codebase has no per-employee *hourly cost rate*
concept yet — only a *billing* rate (`projects.defaultHourlyRate`/
`project_tasks.billingRate`, what the customer is charged, never what the
work cost the business) — so there is no honest number to compute labour
cost from. Billable and non-billable hours are reported alongside the
financials instead of folded into a fabricated cost total; once billable
time is actually invoiced, its dollar value already appears in Actual
Revenue the normal way, through the invoice line it produced. A later
slice that introduces an employee cost rate can extend `sumProjectActuals`
to add a labour cost line without changing this service's shape or its
callers.

Time itself — the start/stop timer's duration — is computed by
`src/domain/projects/time-calculations.ts`'s `calculateDurationHours`,
which applies this codebase's money rule to hours too: a `decimal.js`
calculation from millisecond integers, rounded with the same
`ROUND_HALF_EVEN` convention `Money` uses (`docs/decisions/0003-monetary-precision.md`),
never a naive floating-point division that would compound rounding error
on a long-running timer.

## 10. Phase 7 Slice 2 — perpetual inventory and COGS-at-sale-time

Inventory in this codebase is **perpetual, not periodic**: there is no
period-end "count stock, back into COGS" process. Every purchase and sale
of a `TRACKED_INVENTORY` product (`src/db/schema.ts`'s `products`) updates
its on-hand quantity and weighted-average cost the moment it's posted, and
a sale's COGS is posted **in the same transaction, and the same journal
entry, as the sale's own revenue/tax lines** — not a separate disconnected
batch job, not a month-end adjustment. This is the standard double-entry
treatment a perpetual-inventory system requires: a sale is never "just"
Debit AR / Credit Revenue (+ tax); it is also Debit COGS / Credit Inventory
Asset for a tracked product, both legs landing on the invoice's own posted
entry.

- **Costing method**: weighted-average only
  (`src/domain/inventory/costing.ts`). On a purchase, the new average is
  `(oldQty × oldAvgCost + purchaseQty × purchaseUnitCost) / (oldQty +
  purchaseQty)` — the textbook formula, computed in `decimal.js`, never a
  float. A sale never changes the average — it consumes at whatever the
  average currently is. `inventoryCostingMethodEnum` is a Postgres enum
  with a single value today specifically so FIFO (master spec §20) can be
  added as a second value later without a schema restructuring — the same
  reasoning `ai_autonomy_level`'s doc comment gives for levels 3/4.
- **Where the postings happen**: `InvoiceService.approveAndPost` and
  `BillService.approveAndPost` are the only two call sites that touch
  inventory, and both already own a `PostingService.postJournal` call for
  the document's normal revenue/tax or expense/tax lines — `InventoryService`
  (`src/domain/inventory/inventory-service.ts`) is invoked from inside
  that same transaction, under a `SELECT ... FOR UPDATE` lock on the
  product row, so a stock mutation and its accompanying journal entry
  always commit or roll back together. A purchase needs no *extra* journal
  lines at all: `BillService` resolves a tracked-inventory line's
  `accountId` onto the product's own `inventoryAssetAccountId` before the
  normal debit aggregation runs, so the existing debit already lands on
  the right asset account. A sale needs an extra COGS debit/inventory-asset
  credit pair, computed from `InventoryService.recordSale`'s return value
  and appended to the same `journalLines` array `InvoiceService` was
  already building.
- **Oversell is a hard refusal, not a soft one**: `costing.ts`'s
  `applySale` throws `InsufficientStockError` before any mutation happens
  if the sale would take quantity negative, which aborts the whole
  transaction — the invoice is never posted, no partial state exists. This
  codebase has no backorder concept; an oversell is never queued.
- **Void is refused for a tracked-inventory line**: `PostingService`'s
  reversal-only rule (§1 above) says a posted entry is never edited, only
  reversed — and reversing an invoice/bill's journal is easy. Reversing the
  *stock* and *weighted-average cost history* correctly is not: a later
  movement may already have built its own average on top of this one, so
  simply "undoing" it would compute a wrong number, not a safe no-op. Both
  `InvoiceService.voidInvoice` and `BillService.voidBill` refuse outright
  (`VoidWouldDesyncInventoryError`) when any line carries a
  `TRACKED_INVENTORY` product, rather than performing an incorrect
  reversal — the correction path is a manual `InventoryAdjustmentService`
  entry for the stock, plus an accountant's manual journal for the
  revenue/COGS reversal, until a real reversal scheme is built.
- **The correctness check**: `InventoryValuationService` sums
  `quantityOnHand × averageUnitCost` across every `TRACKED_INVENTORY`
  product, grouped by `inventoryAssetAccountId`, and compares it against
  that account's own posted GL balance (`sumPostedActivityByAccount`,
  §8a's shared helper) — the same spirit as §8's Balance Sheet equation
  check. Since every movement's value and its accompanying journal line
  are posted together (never one without the other), the two numbers are
  independent paths to the same fact and should always agree exactly; a
  non-zero difference is a real bug to fix, not a rounding footnote to
  paper over.
- **Scope**: one implicit location per org (no warehouse/bin model, so
  nothing to allocate across), weighted-average only (FIFO deferred, see
  above), no backorders, no landed costs, no bundles/kits, no serial/lot
  tracking. See `docs/roadmap.md`'s Phase 7 Slice 2 entry for the full
  deferral list and reasoning.

## 11. Phase 7 Slice 3 — fixed assets: depreciation, disposal, and a register that never posts its own acquisition

Fixed assets differ from inventory in one structural way worth calling out
explicitly: **registering an asset never posts a journal for the
acquisition itself.** For inventory, `InventoryService` posts alongside
`BillService`/`InvoiceService` in the very same transaction (§10 above).
For a fixed asset, the cost is **already** sitting in the designated asset
account by the time `FixedAssetService.registerAsset`/`registerFromBillLine`
runs — either because a bill line was coded directly to that account (the
normal path: the bill's own existing debit already covers it, so
`registerFromBillLine` only reads the already-posted line's
`accountId`/`lineAmount`/the bill's `issueDate` and links them, the same
"no second posting needed" reasoning §10 gives for a PURCHASE movement) or
because a manual journal/opening-balance import put it there (the
standalone path — required to exist since not every asset arrives via a
bill in this codebase). `FixedAssetService` is purely a subsidiary ledger;
`FixedAssetRegisterService` is the correctness check that proves the
register and the GL agree, in the same spirit as `InventoryValuationService`
(§10's "correctness check") and the Balance Sheet equation check (§8) — it
sums `acquisitionCost - accumulatedDepreciation` across every ACTIVE asset,
grouped by (asset account, accumulated-depreciation account) pair, and
compares that against those two accounts' own posted GL balances. A
non-zero difference is a real bug (a bill coded to the wrong account, an
asset registered against the wrong pair), never a rounding footnote.

- **Depreciation is periodic, not continuous, and strictly monthly**:
  `DepreciationService.runForPeriod` always depreciates one calendar month
  at a time — a deliberate, simple choice (master spec §28 specifies no
  particular cadence) that makes idempotency a structural property rather
  than a convention callers have to honor correctly: `depreciation_entries`
  has a `UNIQUE (organizationId, assetId, periodStart)` index, so a given
  asset/month pair can be inserted at most once, full stop. `runForPeriod`
  checks for that row before computing anything and skips an asset outright
  if found — running the same month twice is a no-op the second time, not
  just "produces the same answer twice."
- **One combined journal entry per run**, not one per asset: a line pair
  (debit Depreciation Expense, credit Accumulated Depreciation) per asset
  with a non-zero charge, all on the same entry, so reviewing a month's
  depreciation across a whole register is one journal, not N. An asset
  whose charge is exactly $0 this period (not yet acquired as of
  `periodEnd`, or already fully depreciated) still gets a
  `depreciation_entries` row — necessary for the idempotency check above to
  ever see it as "already run" for that month — but contributes no line to
  the journal, since `PostingService` rejects a $0 debit/credit line as
  neither a debit nor a credit.
- **Straight-line only**: `(acquisitionCost - residualValue) /
  usefulLifeMonths` per month, computed in `decimal.js` per §4, prorated by
  whole days for an asset acquired mid-period
  (`src/domain/fixed-assets/depreciation-calculations.ts`), and capped so
  `accumulatedDepreciation` never exceeds the depreciable base regardless
  of how many periods are run past full depreciation.
  `depreciationMethodEnum` is a Postgres enum with a single value today,
  the same "room for a second value later with no restructuring" reasoning
  `inventoryCostingMethodEnum` documents for FIFO — declining-balance and
  the other master-spec-§28 methods are deferred rather than half-built
  alongside it (see that module's doc comment for why).
- **Disposal and write-off are one-way, like voiding an invoice**:
  `disposeAsset` (sale) and `writeOffAsset` (no proceeds) both remove the
  asset's full cost and accumulated depreciation via `PostingService`, and
  both are terminal — `fixedAssetStatusEnum` has no path back to `ACTIVE`.
  A mistaken disposal/write-off is corrected with a manual correcting
  journal, never an edit to the original event — the same reversal-only
  discipline `PostingService.reverseEntry` enforces for every other posted
  entry (§1). `disposeAsset` recognizes `proceeds - netBookValue` as a gain
  (credited) or loss (debited); `writeOffAsset` always recognizes the full
  remaining net book value as a loss, since there are no proceeds to net
  against it.
- **Scope**: straight-line depreciation only (see above), no tracked
  asset-transfer workflow (`locationReference` is a plain editable field,
  not a workflow with its own audit trail), no automatic/scheduled
  depreciation runs (the same job-queue gap every recurring process in this
  codebase has), no revaluation/impairment. See `docs/roadmap.md`'s Phase 7
  Slice 3 entry for the full deferral list and reasoning.

## 12. Phase 8 Slice 1 — payroll journal conventions

- **One journal per pay run, not per employee** — the same "one combined
  entry, not N" convention `DepreciationService.runForPeriod` uses for
  depreciation: a payroll manager running a fortnightly pay run across a
  whole team wants one journal to review, with `pay_run_lines` giving the
  per-employee breakdown for display even though only one entry posts.
- **The journal itself** (`PayRunService.post`): debit Wages Expense for
  the sum of gross pay across every line; debit Superannuation Expense for
  the sum of superannuation guarantee; credit PAYG Withholding Payable for
  the sum of PAYG withheld; credit Superannuation Payable for the same
  superannuation guarantee sum; credit Net Wages Payable for the sum of net
  pay. All five accounts are chosen per pay run (not fixed per
  organization) and frozen on `pay_runs` once created, the same "account
  wiring chosen at creation, never re-derived" convention `fixedAssets`
  uses for its own account columns.
- **"Posted" is distinct from "paid," on purpose**: Net Wages Payable is a
  LIABILITY account, not a bank account — a posted pay run records the
  obligation to pay employees, not an actual bank transfer, exactly the
  same separation `PaymentRunService` already draws between approving a
  supplier payment run and an actual bank-file payment (neither exists as
  a real external integration in this codebase). Settling net wages is a
  separate, later manual payment against that payable — this slice does
  not model it as a special payroll-specific transaction type.
- **DRAFT then POST, not a single irreversible step**: unlike
  `DepreciationService.runForPeriod` (which posts immediately when called,
  since the run itself IS the deliberate action), `PayRunService.create`
  only computes and stores `pay_run_lines` for review, posting nothing and
  touching no employee's leave balance; `PayRunService.post` is the single
  later step that posts the journal AND applies accrued leave together.
  This mirrors the bill/invoice "DRAFT then approve/post" pattern instead,
  because a pay run's inputs (timesheet hours, manual overrides) are more
  likely to need a human review pass before the irreversible step than a
  mechanical depreciation calculation is.
- **Immutable once posted, like every other posted entry**: correcting a
  posted pay run (wrong hours, wrong employee, a bad GL account) is a
  `PostingService.reverseEntry` on the resulting journal plus a new,
  correct pay run — never an edit to `pay_runs`/`pay_run_lines`.
- **Superannuation quarter-to-date tracking has no separate running-total
  table** — `SuperCalculations` reads the sum of this employee's prior
  **POSTED** `pay_run_lines.ordinaryTimeEarnings` within the same standard
  calendar SG quarter, rather than maintaining a second mutable total that
  could drift out of sync with the pay run history itself (the DRAFT/POST
  split above makes this safe: a discarded DRAFT was never summed in).
- **Scope**: see `docs/roadmap.md`'s Phase 8 Slice 1 entry for the full,
  explicit list of what AU payroll figures were verified vs. deliberately
  left unresolved (Payday Super's FY2026-27 mechanics, the NAT 1004
  per-period coefficient tables, the no-tax-free-threshold schedule) — this
  phase is the one place in the codebase where "verified regulatory figures
  only, never recalled from training data" is the binding constraint, not
  just double-entry correctness.

## 12a. Phase 8 Slice 2 — BAS / GST preparation (preparation only; NOT lodged with the ATO)

Everything in this section requires registered tax agent / BAS agent review. Money Matters prepares a Business
Activity Statement **worksheet**; it never transmits anything to the ATO and has no lodgement integration.

**Where the figures come from.** GST is recorded on the SUB-LEDGER lines (`invoice_lines`, `bill_lines`,
`supplier_credit_note_lines`, `expense_claim_lines`: `lineAmount`/`amount` is GST-exclusive, `taxAmount` the GST), and the
posting journals carry only the control-account totals (the invoice journal lines have no `tax_code_id`). So the BAS reads
the sub-ledger lines of documents whose posting journal is dated in the period. Nothing else is read.

**Basis.** ACCRUAL (invoice / bill basis) only: a document counts in the period its posting journal is dated; a void or
reversal is a NEGATIVE contribution in the period the reversal journal is dated (exactly how the ledger itself treats
it), found through `journal_entries.reversal_of_id`. **CASH basis is refused** (`BasBasisNotSupportedError`): it needs
payment-level GST allocation (apportioning each part-payment's GST), which is not built. Failing closed was chosen over
approximating.

**Classification** (`tax_codes.bas_treatment`, `tax_codes.bas_capital`; NULL treatment = UNCLASSIFIED, never guessed):

| Treatment | Sales | Purchases |
|---|---|---|
| TAXABLE | G1 (GST-inclusive), 1A | G11 (or G10 when `bas_capital`), GST-inclusive, 1B |
| GST_FREE | G1, G3 | disclosed memo, excluded |
| EXPORT | G1, G2 | disclosed memo, excluded |
| INPUT_TAXED | G1 only (memo) | disclosed memo, excluded |
| NOT_REPORTED | excluded (memo) | excluded (memo) |

A line is **unclassified** (in no label, counted and shown) when it has no tax code, an unclassified code, a
foreign-currency document, or GST on a non-TAXABLE code. Supplier credit notes are negative purchases. Labels implemented:
G1, G2, G3, G10, G11, 1A, 1B, W1, W2 (each cross-confirmed from two independent sources; see `docs/roadmap.md`). 8A/8B/9 are
deliberately NOT implemented (sources conflict on the PAYG/summary flow); "1A - 1B + W2" is shown as a clearly-labelled
Money Matters summary, not an ATO label. W1/W2 are the sums of `pay_run_lines.gross_pay` / `payg_withholding` of non-DRAFT
pay runs by pay date. Nothing is rounded (4-dp exact sums); whole-dollar rounding is left to the preparing agent.

**Ledger gaps flagged, not guessed.** (1) Bank-coded transactions (`ReconciliationService.createJournalFromTransaction`) set
a `tax_code_id` on the journal line but post the GROSS amount to one account with no GST split; the BAS cannot know how much
was GST in the ledger, so those lines are listed as "tax-coded journal lines with no GST split" and excluded.
(2) Purchases under GST-free/input-taxed codes: their placement at G11 is not verified, so they are disclosed and excluded.

**Reconciliation to the GST control accounts** shows, per account, period debits/credits (the payable account of every tax
code = "GST on sales", the receivable account = "GST on purchases") against 1A/1B and a net **variance** (ledger minus
BAS). It is never plugged; control-account postings that are not invoices/bills/credits/claims (manual journals, BAS
payments to the ATO) are listed as the usual explanation.

**Lifecycle.** `BasService`: `createDraft` (`bas:manage`) → live recomputation on every view → `finalise` (`bas:finalise`,
HUMAN actors only) which stores the full report JSON plus a SHA-256 `content_hash` over a canonical (sorted-key) JSON and
makes the row immutable (the RLS UPDATE/DELETE policies only match DRAFT rows). Outstanding warnings (unclassified lines,
no-split lines, variance, a period whose months are not all `ADVISOR_LOCKED` or stricter) must be acknowledged. A FINALISED
view re-verifies the hash and shows "live drift" if the ledger moved afterwards; a revision is a new statement.
`bas_lodgement_records` (append-only) holds "lodged outside Money Matters" (date + reference, unverified).

## 12b. Phase 8 Slice 3 — payroll operations: settlement, remittances, reversal, leave

All postings go through `PostingService`; nothing here moves real money (Money Matters pays no one and lodges nothing).

- **Net wages settlement** (`PayrollPaymentService.payNetWages`): Dr Net Wages Payable / Cr the chosen bank (ASSET) account, for what is still owed on one POSTED run (net of earlier unreversed payments). Recorded in `payroll_payments` (kind `NET_WAGES`). The ABA (Direct Entry) file is generated separately and generating it records nothing.
- **Super and PAYG remittances** (`recordSuperRemittance` / `recordPaygRemittance`): Dr Superannuation Payable (or PAYG Withholding Payable) / Cr bank, capped at `accrued on POSTED runs - remitted` (computed from the pay run sub-ledger in `liabilities.ts`, not from the GL balance). Record-only: no clearing house, no payment to the ATO.
- **Reversal** (`PayRunService.reverse`, `payrun:reverse`, reason of 10+ characters): reverses the posting journal via `PostingService.reverseEntry` (original untouched), sets the run `REVERSED`, unwinds each employee's leave balance (accrual removed, leave taken restored), releases the leave requests the run consumed, and drops the run out of quarter-to-date OTE and the duplicate-period check so a corrected run can cover the same period. Refused while net wages are recorded as paid, or when removing the run would leave more super/PAYG remitted than owed. The BAS treats a reversed run as a negative in the period its reversal journal is dated.
- **Leave** (`LeaveService`): an employee (login linked to an ACTIVE employee record) requests hours of ANNUAL or PERSONAL leave; a different person with `leave:approve` decides it; approval is refused when hours exceed the balance after other approved-but-undeducted leave. A draft pay run freezes the approved hours on each line (`annual_leave_taken`, `personal_leave_taken`); `post()` re-checks them (a stale draft refuses to post), deducts them from the balance, stores the balances after the run for the payslip, and marks the requests applied. Leave is **balance-only**: gross pay is not changed, so for an HOURLY employee the paid hours must still be entered by the payroll manager. Hours are typed by the requester: no roster, public-holiday or entitlement logic.
- **Payslips** (`PayslipService`): one per employee per POSTED run: gross, PAYG, net, SG accrued, leave accrued/taken/balance after, year to date from 1 July (the Australian financial year start) up to and including the run. No TFN; bank account masked. Human-only. See docs/security.md section 13b for who may read what.
- **Reports** (`PayrollReportService`): payroll summary, PAYG summary (withheld vs remitted by month), super liability by calendar quarter (SG due dates not modelled), and an annual-leave liability estimate (hours x base hourly rate; no loading, on-costs or award rates; personal leave in hours only). Each has a CSV export with the same permissions.
- **ABA file** (`aba-file.ts`): layout verified against two sources (Westpac Corporate Online "Import format for Australian Direct Entry files", January 2018 PDF, and the Cemtex ABA specification). Credits only (transaction code 53 "pay"); no balancing debit record (bank-specific, unverified). Amounts are whole cents per employee, so the file total differs from the ledger payable by the reported sub-cent rounding; the ledger payment clears the exact payable.

**Phase 8 Slice 4 changes to the payroll maths** (verification detail in docs/roadmap.md): for pay dates in FY2026-27 the default rule set is now version 2 (Payday Super): SG is 12% of qualifying earnings on EVERY payday, accumulated from 1 July against the annual maximum contribution base ($270,830, so at most $32,499.60 a year), and each line records a conservative `super_safe_by_date` (six weekdays after payday; not the legal deadline, public holidays and clearing-house time are not modelled). The quarterly mechanism survives as the labelled legacy option (`legacyQuarterlySuper`). A `FOREIGN_RESIDENT` employee is withheld with the foreign resident brackets, no tax-free threshold and no Medicare levy, by the same annualised-bracket approximation; if a rule set has no foreign resident brackets the calculation refuses rather than using resident rates. The Medicare levy shade-in (10 cents per dollar over the lower threshold, capped at 2%) is now a verified mechanism; the 2026-27 thresholds themselves are still the 2025-26 figures, flagged on the rule set.

Known limitation found while building this (pre-existing, not changed here): `PostingService` requires `journal:post`, which `PAYROLL_MANAGER`, `ACCOUNTS_RECEIVABLE` and `ACCOUNTS_PAYABLE` do not hold, so a service that posts on their behalf fails for those roles in practice. In practice payroll posting, settlement and reversal therefore work only for roles that hold both the payroll permission and `journal:post` / `journal:reverse` (OWNER, ADMINISTRATOR, ACCOUNTANT); a PAYROLL_MANAGER can prepare and review but is refused at the ledger. Resolving this needs a deliberate decision about system-initiated postings, so it is reported rather than silently widened.

## 13. Phase 9 Slice 1 — budgets never touch the ledger; Budget vs. Actual reuses the P&L's own aggregation

- **A budget is planning data, full stop.** No table in `src/domain/
  budgeting/` has a `journalEntryId`, and `BudgetService` never imports
  `PostingService`. This is the one domain area in this codebase whose
  entire reason for existing is to be compared against the ledger, never
  to post to it — unlike every prior phase, where "does this call
  `PostingService`" is the first question to ask of a new mutation, here
  the answer is structurally always no.
- **Budget vs. Actual is a P&L with a second column, not a new report
  shape.** `BudgetVarianceService.getBudgetVsActual` calls the exact same
  `sumPostedActivityByAccount` (`src/domain/ledger/gl-aggregation.ts`)
  every other financial statement calls for its actual side — see §8a.
  There is no second, parallel query path for "the actual figures a
  budget gets compared against." The budget side is a plain sum of
  `budget_lines.amount` for the requested period; both sides are
  normal-balance-signed via `normalSignedBalance`, the same helper
  `buildProfitAndLoss`/`buildBalanceSheet` already use, so a budget figure
  and an actual figure for the same account are always directly
  comparable with no sign-flipping anywhere in the reporting layer.
- **Reconciliation is a union, not an intersection.** An account with a
  budget line and zero actual activity still gets a full row (budget
  amount, $0 actual, a full negative variance) rather than being treated
  as "no report data." An account with actual activity and no budget line
  still gets a row too, with `unbudgetedActivity: true` — flagged, never
  silently dropped. This mirrors the same union-of-both-sides approach
  `buildSection` in `financial-statements.ts` already uses for a P&L's
  comparison-period columns, just applied to (budget, actual) instead of
  (current period, comparison period).
- **Variance percent is `null`, never a computed artifact, when the
  budget side is exactly zero.** Dividing by zero isn't rounded away or
  defaulted to some sentinel number — a `null` forces every caller
  (the report page, the Management Pack) to render "—" rather than a
  misleading "0%" or "∞%".
- **Rolling forecast is a copy, not a window.** `createRollingForecast`
  reads a source budget's lines once, partitions them at a user-supplied
  cutoff date (`partitionLinesForRollingForecast`), and writes the result
  as a new, independent DRAFT budget. Nothing about the source budget is
  referenced again afterward — there is no "live" link that would need
  updating if the source budget later changed, the same one-shot-copy
  discipline `FixedAssetClassService`'s class-to-asset defaulting already
  uses (see §11): a class's defaults are copied once at registration and
  never re-consulted.
- **Budget vs. Actual is scoped to REVENUE/EXPENSE**, the same scope
  `buildProfitAndLoss` itself uses — a budget line against a different
  account type is still fully stored and queryable directly from
  `budget_lines`, just not surfaced by this particular report.

## 14. Phase 9 Slice 2 — forecasts and scenarios: analysis only, with KNOWN and STATISTICAL structurally apart

- **Forecasts and scenarios never touch the ledger.** Like budgets (§13),
  nothing in `src/domain/forecasting/` imports `PostingService` or writes to
  any financial table; tests assert the trial balance is identical before and
  after a forecast/scenario run. The only tables this slice adds are
  `scenarios` (saved parameters) and `cash_forecast_settings` (one threshold).
- **The §38 distinction is a type, not a label.** A forecast line is either
  a `KnownForecastLine` or a `StatisticalForecastLine` (discriminated by
  `kind`; different fields). Series are built by `linesForSeries(lines,
  mode)`: `KNOWN_ONLY` takes known lines only; `INCLUDING_STATISTICAL` takes
  every statistical line plus every known line a statistical line does NOT
  name in `replacesLineId`. A statistical timing shift therefore carries the
  same cash as the known line it supersedes, so no document is ever counted
  twice, and the result exposes two series with no blended total. Statistical
  here means a simple, explainable average (a customer's own historical days
  late from their own settled invoices; a repeat of the last posted pay
  run) — never a forecasting model.
- **Opening cash is one definition.** `loadCashPosition` (extracted from the
  Daily Finance Brief) — a bank account IS its linked GL account's balance,
  from the shared trial-balance aggregation (§8a); the forecast reuses the
  same snapshot for payroll-payable balances.
- **Dates and overdue items.** All dates are UTC-midnight, day 0 is today
  and its end-of-day balance already includes flows dated today; a flow dated
  before today is treated as today (it is still unpaid, which is why it's in
  the forecast). An overdue receivable has a certain amount but no
  determinable receipt date, so it is NOT on the known timeline (prudent for an
  inflow); an overdue payable is assumed due today (prudent for an outflow).
  The series is always computed daily; weekly granularity is display-only for
  the 12-month horizon, so low points and breach dates are day-exact.
- **A due date is never invented.** Posted payroll liabilities (net wages,
  PAYG withholding, super) are known AMOUNTS (the payable accounts' ledger
  balances) with `timing: "UNVERIFIED"` and no date — the remittance rules are
  not verified in this codebase (Phase 8's roadmap notes). They are reported
  as `unscheduledKnown` with a "paid today" prudence floor, not placed on a
  timeline.
- **Recurring templates** are known scheduled commitments: occurrences come
  from the same `advanceRecurringDate` the generators use (honouring
  `endDate`/`maxOccurrences`, including backlog), the amount is recomputed
  from current tax rates exactly as generation does, and the cash date is
  issue date + the generators' fixed 30-day default terms.
- **Scenarios are a transparent monthly what-if, not a model.** Over the next
  12 full calendar months: an unmodified baseline monthly P&L (flat trailing
  actuals from `sumPostedActivityByAccount`, or an ACTIVE budget's lines), plus
  explicit per-type monthly deltas (`hireDeltas`, `priceChangeDeltas`,
  `loseCustomerDeltas` — pure, hand-verified in unit tests), pro-rated by days
  in the first month. Cash is a RUN-RATE path (opening cash + cumulative
  monthly net profit), explicitly not a working-capital model. Money is
  `Money`/decimal.js throughout, percentages and amounts are decimal STRINGS
  in the saved parameters, and rounding is the codebase's usual half-even.
- **Best / Expected / Worst differ only by explicit, editable assumptions**
  (hire: revenue realised 125% / 100% / 0%; price change: the volume change
  assumed per case, expected 0 by default — the price response is NOT
  estimated from history, because a small business's data cannot support an
  honest elasticity; lose-customer: partial replacement after a lag in the
  best case, collections delayed in the worst). Each case lists its
  assumptions in its result. They are modelling assumptions, never
  predictions.
- **Derived inputs come from real data and are shown.** Trailing-12-month
  revenue shares come from posted invoice lines (by customer, product,
  revenue account) against the P&L's revenue; cost of sales is only what is
  actually attributable (tracked-inventory SALE movements linked to the
  invoice lines — §10) — when none exists a result says it is revenue-only.
- **Runway** = months until run-rate cash goes below zero, interpolated
  within the month; `null` means "not within the 12 months modelled", which
  the UI words that way rather than as "infinite".

## 15. Phase 9 Slice 3 — period lock levels, month-end close, and the override/reopen workflow

### 15a. The lock model (master spec §41)

There is **one** period concept — `fiscal_periods` — and its `status` enum is
the lock level. No parallel "closed" flag exists (extending the existing
column kept `PostingService` to a single cheap query and let every existing
caller keep working; a separate close-record table would have meant a second
source of truth for "is this period locked"). The severity order lives in
exactly one place, `LOCK_RANK` in `src/domain/ledger/period-lock.ts` (Postgres
enum order is creation order, not severity), and every decision is a pure
function there (`evaluatePosting`, `evaluateLockChange`), unit-tested over
every level x role.

| Level | Who may post into it |
|---|---|
| `OPEN` | anyone with `journal:post` |
| `SOFT_LOCKED` | nobody routinely. A holder of `period:override_soft` (ACCOUNTANT/ADMINISTRATOR/OWNER) may post **inline with a reason** (>= 10 chars). The journal entry records `lock_override_level`/`lock_override_reason`; a `POSTING_OVERRIDE` row goes in the append-only history; an audit entry `journal.posted_under_lock` is written. |
| `ADVISOR_LOCKED` | only `period:post_advisor_locked` (ACCOUNTANT/ADMINISTRATOR/OWNER) — the accountant is still finalising adjustments. No reason is needed (it is their normal work) but the entry is marked as posted under the lock and recorded in the history. Bookkeepers and everyone else are refused. |
| `TAX_LOCKED` | **nobody, inline.** The period is covered by a lodged return/BAS; a change could invalidate the lodgement. It is a **manual** lock the user applies and labels — there is no tax-lodgement integration. |
| `HARD_LOCKED` | **nobody, inline**, not even the owner with a reason. |

The authority is always the actor's **server-side role**. The only client
input is the free-text reason (`PostOptions.lockOverrideReason`); a reason
never helps a role that lacks the permission. An actor of type `AI`/`SYSTEM`
can never act under a lock or change one, whatever its role (a structural
check on top of the role matrix).

Rejected posts raise `PeriodLockedError` (still constructible with just a
label, so existing callers and tests are unchanged). It now carries
`lockLevel`, a `denialCode`, and `canOverrideWithReason` (the UI uses that to
offer "Post anyway — reason required"), and its message states the
consequence and who can reopen (master spec §79: never a dead end).

**Where a human can override.** `PostingService.postJournal`, `postDraft` and
`reverseEntry` take the `PostOptions`; `InvoiceService.approveAndPost`,
`BillService.approveAndPost` and `SupplierCreditService.approveAndPost` pass
it through. The UI: a manual journal "Post" into a locked period keeps what
the user typed as a DRAFT (drafts are allowed in locked periods) and lands on
it with the explained reason and, for an authorised user on a soft lock, a
"Post anyway — reason required" form; the invoice, bill and supplier-credit
detail pages do the same. Other posting paths (payments, pay runs, depreciation,
expense claims, bank categorisation) are rejected by a lock with the explained
message and no inline override.

**Which period governs a date.** Periods may overlap (an annual period with
monthly close periods inside it), so `findFiscalPeriod` reads every period
covering the date in the one query and the **most restrictive governs** (ties:
the narrowest); a permissive overlapping period can never bypass a lock. The
period **end date is inclusive of its whole UTC day**: periods store the end
as midnight of the last day, and before this slice a posting timestamped
later that day (e.g. a reversal defaulting to `new Date()`) escaped the
lock. A date that falls in no period at all still posts (periods are explicit
rows, never required) — which is also why the close workspace works for
months that exist only implicitly (§15c).

**Corrections never edit history.** Reversing an entry that sits in a locked
period posts the reversal on its own date (today by default — an open
period); a reversal dated into the locked period is refused like any other
posting. Posted lines are never touched by locking or reopening.

### 15b. Migration of the old lock model

Before this slice a period was `OPEN`/`SOFT_LOCKED`/`HARD_LOCKED`, and **both**
locked values rejected every posting by every actor. The new `SOFT_LOCKED` is
weaker (an authorised role may post with a reason), so leaving legacy
`SOFT_LOCKED` rows as they were would have silently loosened an existing
lock. Migration `0037` therefore maps:

| Before | After | Why |
|---|---|---|
| `OPEN` | `OPEN` | unchanged |
| `SOFT_LOCKED` (blocked everyone) | **`HARD_LOCKED`** | identical posting behaviour; nothing loosened. A person with `period:reopen_hard` can lower it through the audited reopen workflow. |
| `HARD_LOCKED` | `HARD_LOCKED` | unchanged |

Each carried-over locked period gets a `MIGRATED` row in the append-only
history (preserving the legacy status, reason and timestamp in its metadata).
The mapping SQL is executed verbatim by a test against legacy-shaped rows,
which also proves nobody can post into a formerly soft-locked period, and it
ran unchanged on the real dev database's legacy FY2026 lock.

### 15c. Lock changes: close, raise, reopen

All level changes go through one function, `changeLockLevel`
(`src/domain/close/period-lock-service.ts`), inside the caller's transaction:
validate (`evaluateLockChange`), update the period under a row lock
(`SELECT ... FOR UPDATE`), append the **who / when / why / before / after**
row to `period_lock_events` (INSERT+SELECT-only for `mm_app`), and write the
org `audit_logs` entry.

- **Raise** a lock (more restrictive): `period:close`. A reason is optional.
- **Lower / reopen**: `period:reopen` for SOFT/ADVISOR; **`period:reopen_hard`
  (OWNER/ADMINISTRATOR only)** to leave TAX or HARD. A reason of at least 10
  characters is mandatory; leaving `TAX_LOCKED` also needs a typed
  acknowledgement containing "may invalidate a lodgement". A reopen can
  lower to an intermediate level (e.g. HARD -> ADVISOR) and records
  `REOPENED` (to OPEN) or `LEVEL_LOWERED`.
- The legacy `FiscalPeriodService.setStatus` is kept for compatibility but now
  routes through the same two paths, so it can no longer sidestep them.

### 15d. Month-end close (master spec §40)

`period_closes` holds one row per (period, **cycle**). Cycle 1 is the first
attempt; **every reopen starts a new cycle**, so the earlier CLOSED row (with
its checklist snapshot) is immutable history, and manual sign-offs
(`close_signoffs`, per cycle) must be redone after a reopen.

The workspace addresses a period by calendar-month key `YYYY-MM` (works for
months with no row) or by period id (annual/custom ranges). A month with no
`fiscal_periods` row is an implicit OPEN period; the first mutation (a
sign-off or a close) materialises it as a row labelled `YYYY-MM` (start = first
day, end = midnight of the last day, the existing convention), audited as
`fiscal_period.created`. A month inside a locked annual period shows the lock
that covers it, and the most restrictive lock governs posting.

**Closing** (`PeriodCloseService.close`, `period:close`): compute the live
checklist; refuse with `CloseBlockedError` listing every BLOCKING item;
require an explicit acknowledgement when outstanding (ATTENTION or unsigned
manual) items remain; then in one transaction lock the period at the chosen
level, complete the cycle with the **checklist snapshot**, append the lock
event and write the audit entry `period.closed` (snapshot, acknowledged item
ids, "closed with N outstanding items acknowledged"). The **default level is
SOFT_LOCKED**: month-end is routinely followed by late adjustments, so the
default stops accidental posting by routine users while letting an accountant
post with a recorded reason; the harder levels are deliberate steps (ADVISOR
while finalising, TAX after lodgement, HARD for year-end/final). Closing out of
sequence is a **warning, not a block** (an ATTENTION item that needs the
acknowledgement): businesses legitimately catch up late or out of order, so
blocking would force workarounds, but it must be deliberate and is recorded.
The checklist is computed immediately before the closing transaction (its own
queries need their own sequential connections), so the snapshot is the state at
close time within milliseconds.

### 15e. How the checklist computes

`CloseChecklistService.compute` recomputes **every automatic check from live
data on every view — nothing is stored**, so a tick can never be stale. It is
sequential and set-based by design (the DB connection rule): all of its own
queries share ONE tenant transaction (aggregates, no row loading), which is
closed before the three existing reporting services are called one at a time.

| Check | Source | Status logic |
|---|---|---|
| Bank accounts reconciled (one per active account) | `bank_transactions` UNMATCHED dated on/before the period end | ATTENTION if any; N/A with no bank accounts |
| Draft invoices / bills / supplier credit notes | DRAFT documents dated in the period | ATTENTION |
| Expense claims approved | SUBMITTED claims dated on/before the period end | ATTENTION |
| Pay runs posted | DRAFT pay runs paid in the period (**needs `payrun:read`; omitted and counted as hidden otherwise**) | ATTENTION |
| Depreciation run | active assets acquired by the period end lacking a `depreciation_entries` row for the month of the period end | ATTENTION; N/A with none |
| Fixed asset register reconciles | `FixedAssetRegisterService` | **BLOCKING** on a mismatch; N/A with no active assets |
| Inventory valuation reconciles | `InventoryValuationService` | **BLOCKING** on a mismatch; N/A with no tracked products |
| Trial balance debits = credits | SUM over non-draft lines to the period end | **BLOCKING** |
| Balance Sheet balances | `ReportingService.getBalanceSheet` | **BLOCKING** |
| Suspense/clearing accounts nil | accounts the org itself named *suspense*/*clearing*/*undeposited* | ATTENTION if non-zero; **N/A (stated honestly) when none exist — the platform creates none by default** |
| No draft journals | DRAFT journals dated in the period | ATTENTION |
| Earlier period closed first | the period before this one, if there is earlier posted activity | ATTENTION (warning) |
| Manual (sign-off): accruals, prepayments, tax review, P&L review, Balance Sheet review, budget variance (N/A with no budget), foreign exchange (N/A without foreign-currency lines), intercompany (always N/A — single-entity) | `close_signoffs` | `MANUAL` until a named person signs off, then `PASSED` with `verifiedBy: HUMAN` |

BLOCKING is reserved for ledger-integrity problems (the code's own comments
call a register/GL mismatch a real bug, never rounding); the rest are
judgement calls that need an acknowledgement. The register and inventory
comparisons use the GL **as of today**, not the period end, because those
registers hold current balances.

**Progress** = `PASSED items ÷ applicable items`, where applicable = visible
items minus NOT_APPLICABLE; a signed-off manual item counts as complete but is
shown as a person's attestation, never system verification. Items hidden from
the actor's role (e.g. payroll without `payrun:read`) are excluded from both
counts, and a role that cannot see every item cannot close. No applicable
items reads 100.

### 15f. Tables

`period_closes` (SELECT/INSERT/UPDATE), `close_signoffs` (SELECT/INSERT/DELETE
— revocation is audited), `period_lock_events` (**SELECT/INSERT only**), all
RLS-enabled + FORCEd with a tenant policy. `journal_entries` gained
`lock_override_level`/`lock_override_reason`. See `docs/database.md` §2o.

## 16. Phase 9 Slice 4 — multi-entity consolidation (master spec §30)

Consolidation is **read-only, computed live, never stored, and never posts
anything**. The per-entity statements are the existing `ReportingService`
outputs (P&L, Balance Sheet) and `loadCashPosition`, fetched one entity at a
time with the user's real role in each (`docs/security.md` §12); the pure engine
in `src/domain/consolidation/` (`account-mapping.ts`, `eliminations.ts`,
`consolidate.ts`) then aggregates them in memory with `src/domain/money`
decimals only. It re-derives no ledger logic — a consolidated line is a sum of
amounts an entity's own report already produced.

### 16a. Account mapping (charts of accounts do not align on their own)

A consolidated line is a **group account**: a row of the group's own chart
(`entity_group_accounts`, keyed `(type, code)`). The first entity added seeds the
chart from its accounts; the user can add more. Each entity account resolves, in
order:

1. an **explicit mapping** (entity account → group account) set by the user —
   valid only if the group account's type equals the account's type (a stale
   cross-type mapping resolves to *unmapped*, never to a wrong line);
2. the **default rule**: the group account with the **same type and the same
   code** (type is part of the key: code 1500 as an asset in A and as an expense
   in B are different lines);
3. otherwise **Unmapped**: an explicit "Unmapped assets / liabilities / equity /
   revenue / expenses" bucket per section, listing each source account, **included
   in every total** and flagged with a link to the mapping screen. Nothing is
   dropped; nothing is silently merged.

Why not "match by name": names are free text and drift ("Sales" / "Revenue —
Sales"); code+type is the one stable, user-visible key the chart already has,
and the explicit mapping covers everything it cannot. The two computed Balance
Sheet earnings lines are recognised by their labels (exported constants in
`financial-statements.ts`, covered by a drift test) and consolidated as their own
lines.

### 16b. Intercompany eliminations

A user designates entity accounts as intercompany with a **named counterparty
entity** (which must be in the group) and a kind, whose side is fixed:

| kind | account type | side |
|---|---|---|
| RECEIVABLE / LOAN_RECEIVABLE / REVENUE | asset / asset / revenue | creditor |
| PAYABLE / LOAN_PAYABLE / EXPENSE | liability / liability / expense | debtor |

For every ordered pair (creditor entity A, debtor entity B) and category (TRADE,
LOAN, INCOME_EXPENSE), side A is the sum of A's accounts designated as the
creditor kind naming B, and side B is the sum of B's accounts designated as the
debtor kind naming A — normal-signed. **Only the matched part, `min(A, B)` when
both are positive, is eliminated, equally from both sides.** Because exactly the
same amount leaves assets and liabilities (or revenue and expense), every
consolidated statement still balances exactly; and because only the matched part
leaves, a real discrepancy is never forced to net to zero. The reconciliation
list reports, per pair: the creditor's amount, the debtor's amount, the amount
eliminated, the difference, and a status — `MATCHED`, `MISMATCH`, `ONE_SIDED`
(one side has no balance/designation), or `COUNTERPARTY_UNAVAILABLE` (the other
entity is not in this report because the user has no access; it is not named).
With several designated accounts on a side the matched amount is allocated across
the positive balances in code order, so the elimination journal names exactly
what it reduced.

Eliminations are **computed presentation entries**: shown in the "Elim. & adj."
column and as Dr/Cr entries on the page, stored nowhere, posted nowhere.
Balance-sheet pairs (trade, loan) are evaluated in the Balance Sheet; revenue/
expense pairs in the P&L (net profit is unchanged by a matched elimination).
Posting an elimination into an entity's ledger would be a cross-tenant write and
is explicitly out of scope; auto-mirrored intercompany invoices/loans likewise.
Each entity records its own side normally.

### 16c. Manual consolidation adjustments

Group-level, **append-only** journals (`entity_group_adjustments` + `_lines`,
`mm_app` SELECT+INSERT only) against **group accounts**, with an effective date,
a description and a mandatory reason. Every adjustment must balance exactly
(decimal arithmetic, ≤ 4 dp). They are undone only by a new mirror-image row
(`reverses_adjustment_id`, at most one reversal, a reversal cannot be reversed).
In the Balance Sheet an adjustment on an asset/liability/equity account moves
that line from its effective date onwards; one on a revenue/expense account
changes *earnings* — current-year earnings if dated in the report's calendar
year, retained earnings (prior periods) before it (the same calendar-year
convention as §8b). In the P&L only adjustments dated inside the period apply.
They never touch any entity's `journal_entries`, trial balance or audit log
(asserted byte-for-byte). A group-level investment-in-subsidiary vs. equity
elimination is done as one of these; it is not automatic (it needs
acquisition-date accounting for goodwill and pre-acquisition reserves).

### 16d. The Balance Sheet proof

Each column of the consolidated Balance Sheet is checked independently:
`Assets − (Liabilities + Equity)` for **every entity**, for **Combined**, for the
**adjustments** column and for **Consolidated**. Entity columns balance because
each entity's own report does; Combined is their sum; an elimination removes the
same amount from both sides of the equation; a balanced adjustment contributes
`Σ(debit − credit) = 0` across asset, liability, equity and earnings lines
(P&L-account lines are carried into the earnings equity lines as
`credit − debit`). Hence Consolidated balances exactly, and the page shows the
same ✓/✗ banner as a single entity. Mismatched intercompany balances do **not**
break it — the unmatched remainder simply stays in the consolidated figures on
its own side, because both sides were reduced by the same (matched) amount.

### 16e. Currency — single base currency only

`organizations.base_currency` is per entity and every journal line carries a
base-currency amount, but there is **no tested translation mechanism**: the
`exchange_rates` table is not read or written by any service. So a group whose
reportable entities have different base currencies is **refused**:
"These entities have different base currencies: AUD, NZD — currency translation
is not yet supported." Translation (closing rate for the balance sheet, average
rate for the P&L, the difference to a translation reserve line) is deferred
rather than built on invented rates. The check looks only at entities the user
can access, so it can never disclose an excluded entity's currency.

### 16f. Cost model

One user-scoped transaction for the group's configuration, one membership query,
then per entity one tenant transaction per statement (P&L, Balance Sheet; two
for cash), strictly sequential and capped at 10 entities — which is why there is
no always-on dashboard widget (an N-entity headline on a home page would hold N
connections' worth of work on every visit).


## 17. Phase 9 Slice 5 — workpaper reconciliation method (master spec §43)

A workpaper is a **practice-owned record of one reading of a client's ledger**, never a
posting. The first kind is a balance-sheet account reconciliation.

### 17a. The snapshot

`LedgerService.getAccountBalance(actor, accountId, asOf)` — one set-based aggregate over
that account's lines (every non-DRAFT entry, REVERSED included, exactly like the Trial
Balance) — returns the balance in the account's **normal direction** (debit-normal for
assets, credit-normal for liabilities and equity) in the base currency. `asOf` is the end
of the period-end day (UTC), so a later posting is not in it. The workpaper stores the
balance with `snapshot_taken_at`, who pulled it and with which client role, and every
pull is an append-only history row. It is labelled "per ledger as at <date>, pulled
<timestamp> by <who>" and is a point-in-time figure, not live.

### 17b. The schedule and the difference

The supporting schedule is a list of signed decimal amounts of two kinds —
**supporting balances** (the bank statement balance, a sub-ledger total) and **reconciling
items** (signed so that an outstanding cheque is negative). With exact decimal arithmetic
(`Money`, never floats; up to 4 decimal places):

```
schedule total = Σ every line
difference     = ledger balance − schedule total
reconciled     ⇔ difference = 0   (tested on the exact value; a sub-cent residue is
                                   displayed, never rounded to 0.00)
```

Hand-checked: ledger 12,000.00; statement 12,450.00; outstanding items −450.00 → schedule
total 12,000.00, difference 0.00. With items −350.00 → total 12,100.00, difference
**−100.00** (the ledger is 100.00 lower than the schedule supports). Signing with a
non-zero difference needs an explicit acknowledgement, recorded in the audit log.

### 17c. Staleness

On view one extra query (the same single-account balance) compares the current balance
to the snapshot; any change, however small, is "stale" and shown with the exact change.
Refreshing pulls a new snapshot (DRAFT only) and keeps the history. When the client has
ended access no check is made and the paper is shown as of its snapshot date.

### 17d. Adjustments are notes

A proposed adjustment (description, amount, account text) is recorded as a note. The
system never posts it: the accountant posts an agreed adjustment through the client's
normal journal screen, then may mark it "posted" with a free-text reference that is
**not verified**. No workpaper code imports a posting service.

### 17e. Review, sign-off and versions

DRAFT → (preparer signs) IN_REVIEW → (reviewer signs) SIGNED_OFF. The preparer must be
the person who prepared it; the reviewer must differ from the preparer **whenever the
practice has two or more active staff**, with a documented exception for a one-person
practice (flagged `single_staff_exception` in the history and the audit log — the same
exception the payment-run slice makes). Every review note must be resolved before the
reviewer signs; notes are resolved, never deleted or rewritten. SIGNED_OFF is immutable
(the database refuses schedule/evidence/note/adjustment changes); a correction is a
**reopen with a mandatory reason** (a manager or partner for a signed-off paper), which
bumps the version and returns it to DRAFT while every earlier sign-off, note and
snapshot stays in the append-only history.

### 17f. Carry-forward

From a SIGNED-OFF workpaper the next period's is created (date defaults to the end of
the following month) with: the schedule **structure** (supporting-balance lines kept
with amounts reset to 0.00 — they must be re-entered from the new evidence), **recurring**
reconciling items copied with their amounts, other reconciling items dropped, and the
prior ledger balance carried as the **comparative** (copied, not recomputed). A fresh
balance is pulled for the new period. **Never carried:** evidence, sign-offs, review
notes, proposed adjustments, the old snapshot (the plan type has no field for them).

### 17g. Practice tax calendar

Recurring deadlines are **rules the practice writes** (frequency; the month a period
ends; months after; due day, clamped to the month's length), turned into tasks on demand
by pure date arithmetic (`src/domain/practice/tax-calendar.ts`); generation is idempotent
per (rule, period end). Nothing is taken from tax law: starter rules are editable form
prefills labelled "suggestion — verify at ato.gov.au". The dashboard's BAS/Tax indicator
shows only the practice's own deadline and the client's tax-lock; **the practice
layer does no BAS/GST preparation itself, and there is no lodgement or ATO integration**
(BAS worksheet preparation, preparation only, is Phase 8 Slice 2 - section 12a).
