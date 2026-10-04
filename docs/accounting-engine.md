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
