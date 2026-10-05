# Database

PostgreSQL, accessed through Drizzle ORM (`src/db/schema.ts`; migrations in
`drizzle/`). This document describes the Phase 1 schema and the conventions
every future migration must follow. See
`decisions/0001-database-orm.md` for why Drizzle rather than Prisma.

## 1. Conventions

- Every tenant-owned table has an `organization_id` column (FK →
  `organizations.id`, indexed) and an application-layer helper that requires
  it (`src/db/tenant.ts`). No repository function accepts "find by id"
  without also taking `organizationId` in its signature.
- Primary keys are UUIDs (`gen_random_uuid()`), not auto-increment integers
  (avoids leaking row counts, and merges cleanly across environments/seeds).
- Monetary columns are `Decimal(19, 4)`. Never `Float`/`Int` cents-hack.
- All tables have `createdAt`/`updatedAt`. Mutable business tables also have
  `createdById`/`updatedById`. Immutable tables (journal lines, audit logs)
  have `createdById` only.
- Closed sets are PostgreSQL enums (`account_type`, `journal_entry_status`,
  `fiscal_period_status`, `membership_role`) — not free-text columns — so
  invalid states are unrepresentable, not just validated.
- Soft-delete is used only where accounting history must be preserved
  (accounts, contacts use `isActive`/`archivedAt`, never a hard delete once
  referenced by a posted transaction). Rows with no financial consequence
  (e.g. a draft not yet posted) can be hard-deleted.

## 2. Phase 1 entity groups

### Identity & tenancy
- `User` — authentication identity (email, hashed password for the
  Credentials provider; `passwordHash` nullable to allow future SSO-only
  users).
- `Organization` — a tenant. `slug`, `name`, `baseCurrency`, `country`,
  `industry`.
- `OrganizationMembership` — join of `User`×`Organization` with a
  `MembershipRole`. A user can belong to many organizations with different
  roles in each (master spec §30, §46).

### Chart of accounts & ledger
- `Account` — chart of accounts entry (`code`, `name`, `type`, `subType`,
  `currency`, `isControlAccount`, `isSystemAccount`, `parentAccountId`).
- `FiscalPeriod` — `startDate`, `endDate`, `status` (`OPEN`/`SOFT_LOCKED`/
  `HARD_LOCKED`).
- `JournalEntry` — header: `entryNumber`, `postingDate`, `memo`, `status`
  (`DRAFT`/`POSTED`/`REVERSED`), `sourceType` (`MANUAL`/`OPENING_BALANCE`/…,
  extensible for later phases' AR/AP/payroll-generated journals),
  `reversalOfId`, `reversedById`.
- `JournalLine` — `accountId`, `debit`/`credit` (`Decimal(19,4)`, exactly
  one non-zero per row — enforced in the domain layer by `PostingService`
  rather than a DB CHECK; see `decisions/0003-monetary-precision.md`), `currency`, `exchangeRate`,
  `baseAmount`, `contactId?`, `taxCodeId?`, `memo?`.
- `JournalLineDimension` — join of `JournalLine`×`DimensionValue`.
- `Dimension` / `DimensionValue` — organization-defined slicing axes
  (Project, Location, Department, Customer, …) per master spec §5.

### Contacts & tax
- `Contact` — unified customer/supplier record (`kind`: `CUSTOMER`/
  `SUPPLIER`/`BOTH`), per master spec §29 ("one complete commercial record").
- `Currency` — reference table (code, name, symbol, decimalPlaces).
- `ExchangeRate` — `fromCurrency`, `toCurrency`, `rate`, `asOfDate`,
  `organizationId?` (nullable = system-wide reference rate).
- `TaxCode` — `code`, `name`, `rate`, `jurisdiction`, `effectiveFrom`,
  `effectiveTo` (versioned, per master spec §26/§88 — never hard-code a
  rate without an effective-date range).

### Governance
- `AuditLog` — append-only. `organizationId`, `actorUserId`, `actorType`
  (`HUMAN`/`AI`, ready for Phase 6), `action`, `entityType`, `entityId`,
  `before` (Json?), `after` (Json?), `createdAt`. No `updatedAt` — it never
  changes.
- `Approval` (schema only in Phase 1; approval *engine* is Phase 3+) —
  generic `entityType`/`entityId`, `status`, `requestedById`, `approvedById`.

## 2a. A Drizzle/Postgres pitfall that reintroduces floats — avoid `with:` on money-bearing relations

Drizzle's relational query API (`db.query.<table>.findFirst({ with: {...} })`)
fetches nested relations on Postgres via a server-side JSON aggregate
(`json_build_object`/`json_agg`). Postgres's numeric→json cast emits the
value as a bare JSON *number* literal, and `JSON.parse` on the Node side
then parses that literal into a native JS float — silently reintroducing
the exact precision loss `docs/accounting-engine.md` §4 forbids. This was
caught empirically during Phase 1 testing: a `numeric(19,4)` value of
`123.4567890123` round-tripped through a nested `with:` query as the float
`123.4568`, while the same column read through a plain `.select()...join()`
query came back as the untouched decimal string.

Rule: never use `with:` (nested relational queries) to fetch a table that
has a `numeric` column, directly or through a further-nested relation. Use
explicit `.select().from().leftJoin()`/`.innerJoin()` and group in
application code instead — see `loadLinesForEntries` in
`src/domain/ledger/ledger-service.ts` for the pattern. `with:` remains fine
for relations with no numeric columns (e.g. joining an `Account` or
`Contact` purely for display fields).

## 2b. The connection layer (`src/db/connection.ts`)

Every database consumer resolves its configuration through one pure,
unit-tested module rather than reading `process.env.DATABASE_URL` directly.
It exists because a misconfigured connection string otherwise surfaces as
`TypeError: Invalid URL` from deep inside the driver, with no indication of
which variable is wrong or why. It:

- **Resolves** from a prioritised list of variable names, so a project wired
  up by Vercel's Postgres/Supabase integration works unchanged
  (`DATABASE_URL`, `POSTGRES_URL`, `SUPABASE_DB_URL`, …). Migrations prefer
  explicitly non-pooled names (`DIRECT_DATABASE_URL`,
  `POSTGRES_URL_NON_POOLING`) because DDL, `CREATE ROLE` and session-level
  settings misbehave through a transaction-mode pooler.
- **Repairs** credentials that are legal as passwords but illegal raw inside
  a URI. `@`, `/`, `?`, `#`, spaces and brackets are all common in generated
  database passwords and all make `new URL()` throw; the parser finds the
  userinfo boundary by scanning right-to-left for a plausible host, then
  re-encodes. Stray wrapping quotes from copy-paste are stripped.
- **Diagnoses**, in operator terms: unsubstituted `[YOUR-PASSWORD]`
  placeholders, whitespace, wrong scheme, missing database name — and maps
  driver errno codes (`ENETUNREACH`, `28P01`, `3D000`, …) to what to
  actually change.
- **Derives** the application's connection from `MM_APP_DB_PASSWORD` plus the
  migration connection's host/database when no runtime connection string is
  set, so the same password is not maintained in two places.
- **Forces the runtime connection onto the `mm_app` role** whenever
  `MM_APP_DB_PASSWORD` is set. Pointing `DATABASE_URL` at the admin connection
  is the natural thing to reach for when the app cannot authenticate, and it
  appears to work perfectly — while disabling row-level security for every
  request (§3 below). A failed connection is a far better outcome than silent
  cross-tenant exposure, so the user and password are rewritten and the
  substitution is reported as a warning. Only the user and password change;
  host, port, database and query parameters are left as configured, migration
  connections keep their owner role, and unsetting `MM_APP_DB_PASSWORD` opts
  out for anyone running a differently-named restricted role.
- **Never logs the password.** `redactConnectionString()` is the only
  sanctioned way to put a connection string in a log line.

A known hosting trap encoded here: Supabase's direct host
(`db.<ref>.supabase.co`) is IPv6-only, and IPv4-only platforms — Vercel
among them — cannot reach it regardless of credentials. `resolveConnection`
emits a warning naming the Session pooler as the fix, and
`explainConnectionError` repeats it if the connection then fails.

A second one, encountered in production rather than anticipated in advance:
a free-tier Supabase project auto-pauses after about a week with no
activity, and every connection then fails with `(ENOTFOUND) tenant/user
<role> not found` — a Supavisor-specific message returned under the
catch-all SQLSTATE `XX000`, easy to mistake for a credentials problem since
nothing about the error code says "paused project". `explainConnectionError`
recognizes this message text specifically and says to restore the project
from the Supabase dashboard, because retrying, rotating a password, or
redeploying all do nothing until the project itself is running again.

`npm run db:doctor` (`scripts/db-doctor.ts`) exercises all of the above
read-only, so a connection problem is one command to identify rather than a
deploy cycle.

**Concurrent deploys against the same database.** Vercel deploys Preview and
Production independently, and both point at the same Supabase database
unless deliberately separated — so two builds starting within moments of
each other (in practice: one `git push` landing on both a feature branch
and `main`) both run `db:migrate:ci` against the same schema at once.
Without protection, the first to commit a pending migration succeeds and
the second's identical `CREATE TYPE`/`CREATE TABLE` collides with what the
first just created, failing an otherwise-correct build with a
duplicate-object error. `src/db/migrate.ts` takes a session-scoped Postgres
advisory lock (`pg_try_advisory_lock`) around the migration step, so a
second concurrent run waits for the first to finish and then finds nothing
pending, rather than racing it — verified by launching two `db:migrate`
processes at once against an empty database and confirming the second logs
"waiting for it to finish" and exits clean.

## 2c. Phase 2 entity groups: banking

- `BankAccount` — a bank account as the org sees it, always paired 1:1 with
  the ASSET `Account` it represents (`glAccountId`) — see
  `docs/decisions/0006-bank-feed-abstraction.md`. `provider`/
  `externalAccountId` are `MANUAL`/null until a live feed is connected.
- `BankImportBatch` — one row per statement upload, for traceability.
- `BankTransaction` — a staged line from an imported statement, not yet part
  of the ledger. `amount` follows the bank's own sign convention (positive =
  in, negative = out). `externalId` is always populated (the provider's own
  id, or a content hash for CSV/QIF — `src/domain/banking/external-id.ts`)
  and unique per bank account, so re-importing a file is a no-op.
- `BankRule` — organization-defined auto-categorization
  (`src/domain/banking/bank-rule-matching.ts`), evaluated in priority order
  against each newly-imported transaction.

A `BankTransaction` becomes ledger history only once reconciled — matched to
an existing posted `JournalLine` (`ReconciliationService.confirmMatch`) or
posted as a new balanced entry with `sourceType: "BANK_TRANSACTION"`
(`ReconciliationService.createJournalFromTransaction`), always through
`PostingService`, so every Phase 1 invariant (period lock, active accounts,
debit=credit) still applies to bank-originated entries.

## 2d. Phase 3 Slice 1 entity groups: sales (customer invoicing & AR)

- `Invoice` — a customer invoice. `arAccountId` names the specific
  Accounts Receivable control account it posts to, chosen explicitly at
  creation time (the same convention as `BankAccount.glAccountId` — no
  per-organization "default account" magic). `subtotal`/`taxTotal`/`total`
  are denormalized from `InvoiceLine`s for cheap list/aging queries, but
  only ever written by `InvoiceService` in the same transaction as the
  lines that justify them. `status` is `DRAFT → APPROVED → (SENT/VIEWED) →
  PART_PAID → PAID`, or `VOID`; there is no stored `OVERDUE` value — see the
  `invoiceStatusEnum` doc comment in `src/db/schema.ts` for why.
- `InvoiceLine` — `accountId` is the revenue account credited on posting;
  `taxCodeId` is optional. `lineAmount`/`taxAmount` are computed and stored
  by `InvoiceService` via `Money`/`decimal.js`, never floating point.
- `Payment` — a customer receipt. `depositAccountId` is the ASSET account
  debited on posting (a bank's own `glAccountId`, or an "Undeposited Funds"
  clearing account); `bankAccountId` is an optional informational link to
  Phase 2's `BankAccount` for later reconciliation.
- `PaymentAllocation` — how much of a `Payment` was applied to a given
  `Invoice`. The join that makes partial payments and one-payment-to-
  many-invoices both work. An invoice's "amount paid"/"outstanding" is
  never a denormalized column — it's computed fresh from this table's rows
  every time (`InvoiceService.loadAllocatedTotal`), so it can't drift.
- `TaxCode.payableAccountId` (added in this slice) — the liability account
  tax collected under a code is credited to on a posted invoice. Nullable
  because Phase 1 tax codes predate this; `InvoiceService` rejects posting
  a line whose tax code has none configured.

An `Invoice`'s only path to the ledger is `InvoiceService.approveAndPost`
(debit AR, credit revenue + tax payable) and `InvoiceService.voidInvoice`
(a full reversal of that same entry) — both go through `PostingService`,
never a direct `journal_lines` write, exactly like Phase 2's banking
reconciliation. Same for `PaymentAllocationService.recordPayment` (debit
deposit account, credit AR).

## 2e. Phase 4 Slice 1 entity groups: purchases (supplier bills & AP)

The purchase-side mirror of §2d above. Suppliers are not a new table:
`Contact.kind` already distinguishes `CUSTOMER`/`SUPPLIER`/`BOTH` (Phase 1),
so `BillService`/`SupplierPaymentAllocationService` reuse `ContactService`
and its RLS as-is.

- `Bill` — a supplier bill. `apAccountId` names the specific Accounts
  Payable control account it posts to, chosen explicitly (the same
  convention as `Invoice.arAccountId`). `billNumber` is this organization's
  own sequential reference (e.g. "BILL-000001"); `supplierReference` is the
  supplier's own invoice number, purely informational and never used for
  uniqueness or posting. `subtotal`/`taxTotal`/`total` are denormalized
  from `BillLine`s for cheap list/aging queries, but only ever written by
  `BillService` in the same transaction as the lines that justify them.
  `status` is `DRAFT → APPROVED → PART_PAID → PAID`, or `VOID` — no
  SENT/VIEWED equivalent, since a bill is received, not delivered.
- `BillLine` — `accountId` is the expense/asset account debited on posting;
  `taxCodeId` is optional. `lineAmount`/`taxAmount` are computed and stored
  by `BillService` via `Money`/`decimal.js`, never floating point.
- `SupplierPayment` — a payment made to a supplier. `paymentAccountId` is
  the ASSET account credited on posting (a bank's own `glAccountId`);
  `bankAccountId` is an optional informational link to Phase 2's
  `BankAccount` for later reconciliation.
- `SupplierPaymentAllocation` — how much of a `SupplierPayment` was applied
  to a given `Bill`. The join that makes partial payments and
  one-payment-to-many-bills both work. A bill's "amount paid"/"outstanding"
  is never a denormalized column — it's computed fresh from this table's
  rows every time (`BillService.loadAllocatedTotal`), so it can't drift.
- `TaxCode.receivableAccountId` (added in this slice) — the asset account
  tax paid under a code (input tax credit, e.g. "GST Receivable") is
  debited to on a posted bill. The purchase-side mirror of
  `payableAccountId`; a tax code can carry both fields at once. Nullable
  for the same reason `payableAccountId` is; `BillService` rejects posting
  a line whose tax code has none configured.

A `Bill`'s only path to the ledger is `BillService.approveAndPost` (debit
expense/asset + tax receivable, credit AP) and `BillService.voidBill` (a
full reversal of that same entry) — both go through `PostingService`, never
a direct `journal_lines` write. Same for
`SupplierPaymentAllocationService.recordPayment` (debit AP, credit payment
account).

## 2f. Phase 3 Slice 2 entity groups: quotes & recurring invoicing

Both extend the Phase 3 Slice 1 sales domain directly rather than
duplicating it — see `docs/roadmap.md` for what's built vs. deferred
(progress/milestone invoicing, the customer portal, AI-drafted collection
reminders).

- `Quote`/`QuoteLine` — shaped like `Invoice`/`InvoiceLine` on purpose
  (`QuoteService` reuses `calculateInvoiceTotals` verbatim), so
  `QuoteService.convertToInvoice` can copy a quote's customer and lines
  straight onto a new draft `Invoice` with no field-by-field translation. A
  quote has no `journalEntryId`/`postedAt` at all — it is pre-sale, not a
  financial transaction, and never calls `PostingService`. `status` is
  `DRAFT → SENT → ACCEPTED/DECLINED`, then `ACCEPTED → CONVERTED` once
  `convertedInvoiceId` is set (once, never re-pointed). There is no stored
  `EXPIRED` value, for the same reason `Invoice` has no stored `OVERDUE`:
  it's a function of `expiryDate` vs. "now", computed at read time.
- `RecurringInvoiceTemplate`/`RecurringInvoiceTemplateLine` — a customer,
  line items, and a schedule (`frequency`, `startDate`, optional
  `endDate`/`maxOccurrences`, `nextRunDate`, `occurrencesGenerated`,
  `isActive`). Deliberately stores no totals: a template's lines are
  recomputed against current tax rates every time it generates an invoice,
  since a template can run for years. `RecurringInvoiceService.generateDue`
  is an on-demand action (a human clicks "Generate due invoices"), not a
  background job — Phase 2 Slice 2's job-queue infrastructure that a real
  schedule would need isn't built yet. It always creates a normal DRAFT
  `Invoice` via `InvoiceService.create` (never auto-approved/auto-posted)
  and advances `nextRunDate` past the generated occurrence in the same
  step, so running it twice the same day is a no-op the second time.
- `InvoiceRecurringSource` — a one-row-per-invoice trace back to the
  template that generated it (purely informational; the idempotency
  guarantee lives entirely in `nextRunDate`, not here).

Neither table changes how an `Invoice` reaches the ledger: a quote's
converted invoice and a recurring template's generated invoice both go
through `InvoiceService.approveAndPost` exactly like a manually created
invoice — no parallel/shortcut posting path.

## 2g. Phase 4 Slice 2 entity groups: purchase orders, recurring bills,
supplier credits, payment runs

Four extensions to the Phase 4 Slice 1 purchases domain, per
`docs/roadmap.md` for what's built vs. deferred (real bank-file/payment-rail
integration, full inventory-backed goods receiving).

- `PurchaseOrder`/`PurchaseOrderLine` — shaped like `Bill`/`BillLine` on
  purpose (`PurchaseOrderService` reuses `calculateBillTotals` verbatim). A
  PO has no `journalEntryId`/`postedAt` — like a `Quote`, it never calls
  `PostingService`. `status` is `DRAFT → SENT → PARTIALLY_RECEIVED/RECEIVED
  → CLOSED`, or `CANCELLED`. `PurchaseOrderLine.quantityReceived` is
  maintained only by `PurchaseOrderReceiptService.recordReceipt`, never
  edited directly, and is the source of truth both the PO's own status and
  the three-way match are derived from.
- `PurchaseOrderReceipt`/`PurchaseOrderReceiptLine` — one row per
  goods-received event and the PO lines it covered. Deliberately lightweight
  (no warehouse location, no serial/lot tracking — that needs Phase 7's
  inventory system) and never posts to the ledger (there is no inventory
  asset account to debit without a real inventory module — the financial
  effect happens once, when the resulting bill is posted).
- `Bill.purchaseOrderId` (added in this slice) — set once, when
  `PurchaseOrderService.convertToBill` creates the bill, never re-pointed.
  Null for a bill entered directly (the common case).
- `BillLine.receiptId` (added in this slice) — an optional link to Phase 2
  Slice 2's `UploadedReceipt` (Document AI capture), reused as-is for bill
  capture exactly the way `ExpenseClaimLine.receiptId` already used it — no
  new extraction/storage code, just the one column.
- `RecurringBillTemplate`/`RecurringBillTemplateLine`/`BillRecurringSource`
  — the purchase-side mirror of `RecurringInvoiceTemplate` et al., including
  reusing `advanceRecurringDate` (`src/domain/sales/recurring-schedule.ts`)
  verbatim rather than a parallel implementation, since the date-advancement
  math has nothing sales-specific about it. Same on-demand
  "generate due bills" action, same DRAFT-only generation via
  `BillService.create`.
- `SupplierCreditNote`/`SupplierCreditNoteLine` — shaped like `Bill`
  (reuses `calculateBillTotals`). Unlike a PO, a credit note *does* post —
  on approval it debits AP and credits the expense/asset + tax accounts
  (the exact mirror of a bill's dr/cr), via `PostingService`, so it's a real
  financial transaction from the moment it's approved.
- `SupplierCreditAllocation` — how much of a `SupplierCreditNote` was
  applied against a given `Bill`, the mirror of
  `SupplierPaymentAllocation` but applied directly rather than through a
  payment (a credit isn't a payment: no payment account, no bank
  reconciliation link). **`BillService.loadAllocatedTotal` sums both
  `SupplierPaymentAllocation` and `SupplierCreditAllocation` together** —
  the single combined source of truth for a bill's outstanding balance, so
  a credit applied and a later cash payment can never independently
  over-allocate past the bill's total.
- `PaymentRun`/`PaymentRunItem` — a batch of bills prepared for payment
  together. `PaymentRun.createdById` is who prepared it;
  `PaymentRun.approvedById` is who approved it, and
  `PaymentRunService.approve` refuses when they're the same user (master
  spec §52's segregation of duties) unless the organization has at most one
  member who can approve at all (see `docs/roadmap.md` for the reasoning).
  `PaymentRunItem.supplierPaymentId` is set once approval generates the real
  `SupplierPayment` for that bill's supplier group — one payment per
  distinct supplier in the run, via
  `SupplierPaymentAllocationService.recordPayment`, never a parallel posting
  path. This slice has no real bank-file/payment-rail integration: "PAID"
  means the payment was recorded in the ledger, the same financial effect a
  manual `SupplierPayment` already has, just batched and approval-gated.

## 2h. Phase 5 Slice 2: `saved_reports` (report builder)

One new table for the report builder (master spec §33) —
`src/domain/reporting/report-builder-service.ts`'s own doc comment has the
full design; this is the schema-level summary.

- `saved_reports` — `organizationId`, `name`, `description`, `visibility`
  (`PERSONAL` | `ORGANIZATION`), `config` (`jsonb`), `createdById`,
  `updatedById`. **`config` is a JSON-serialized `ReportBuilderConfig`, never
  a cached result** — there is deliberately no result/snapshot column here;
  running a saved report always re-executes `config` through
  `sumPostedActivityByAccount` against current data, the same guarantee
  every other report in this codebase gives. `visibility: PERSONAL` is
  readable/deletable only by `createdById`; `ORGANIZATION` is readable by
  anyone in the org holding `financial_report:read` but still only
  editable/deletable by its creator — `ReportBuilderService` enforces that
  narrower, per-row ownership check in application code; RLS's `organization_id`
  policy only ever enforces tenant isolation (which org can see a row at
  all), never a within-tenant visibility rule like PERSONAL vs. ORGANIZATION.
  No `DASHBOARD_WIDGET`/`SCHEDULED`
  visibility exists yet — master spec §33 describes both, but there is no
  dashboard-widget surface or job-queue infrastructure (see Phase 2 Slice
  2's deferral, carried forward every slice since) to attach either to.
- Dimensional reporting (master spec §4) added **no new table** — it reuses
  `dimensions`/`dimension_values`/`journal_line_dimensions` from Phase 1,
  previously schema'd but unused by any report or any UI that could create
  a `Dimension`/`DimensionValue` at all. `src/domain/dimensions/dimension-service.ts`
  is the first CRUD surface for them; `gl-aggregation.ts`'s
  `sumPostedActivityByAccount` gained an optional `dimensionValueId` filter
  (a join against `journal_line_dimensions`), exactly the "one more clause"
  Slice 1's doc comment on that function anticipated.

## 2i. Phase 7 Slice 1: `projects`, `project_tasks`, `timesheet_entries`

Three new tables for Projects/Jobs & Time Tracking (master spec §22/§23) —
`src/domain/projects/`'s own doc comments have the full design; this is the
schema-level summary, including the one deliberate design decision this
slice made that's worth calling out loudly.

- `projects` — `organizationId`, an optional `customerContactId` (null for
  an internal project with no external billing), a unique-per-org `code`,
  `name`, `status` (`ACTIVE`/`ON_HOLD`/`COMPLETED`/`CANCELLED`),
  `budgetedRevenue`/`budgetedCost` (the "Estimated" half of Estimated vs.
  Actual — the "Actual" half is never stored, always computed live, see
  below), a simple `defaultHourlyRate`, and `startDate`/`endDate`.
- `project_tasks` — a deliberately flat per-project task list: `name`, an
  optional `budgetedHours`, and an optional `billingRate` override. No
  dependencies, no assignees beyond the implicit link a `timesheet_entries`
  row carries, no Gantt-style planning — a full task-management system is
  explicitly out of scope for this slice (docs/roadmap.md).
- `timesheet_entries` — `employeeUserId` (unvalidated against `users`, same
  convention as `expense_claims.employeeUserId`), `projectId`, an optional
  `taskId`, `entryDate`, `hours`, optional `startedAt`/`endedAt` (set only
  by the start/stop timer path — manual entry leaves them null and supplies
  `hours` directly; **both paths write the same row shape**), `notes`,
  `billable`, `status`
  (`DRAFT`/`SUBMITTED`/`APPROVED`/`REJECTED`/`INVOICED`), and
  `invoiceId`/`invoiceLineId`, set once by
  `ProjectTimeBillingService.createInvoiceFromUnbilledTime` and never
  re-pointed — the mechanism that makes double-billing structurally
  impossible (see that service's own doc comment). A composite index
  (`organizationId, projectId, status, billable`) exists specifically
  because that's the exact predicate the unbilled-time query filters on.

### Design decision: a dedicated `projectId`/`taskId` FK, not the dimension system

An optional `projectId`/`taskId` pair was added directly to `invoice_lines`,
`bill_lines`, and `expense_claim_lines` — all three, not a subset; none
turned out riskier to touch than the others, since adding a nullable FK
column changes nothing about how any existing caller already behaves, and
the full existing property/unit suite confirms it.

Phase 5 Slice 2's generic `dimensions`/`dimension_values` +
`journal_line_dimensions` (§2h above) exists for exactly this shape of
problem — "tag a line with which business unit it belongs to" — and was
seriously considered as the mechanism for "which project does this cost
belong to" instead of a new column. A dedicated FK was chosen instead, for
three reasons:

1. **Structural, not just reporting, linkage.** A billed timesheet entry
   needs a hard pointer to the exact invoice line it produced
   (`timesheetEntries.invoiceLineId`) so a second invoicing run can
   structurally never reselect it. The dimension system has no equivalent
   of "this row's tag is proof a different row already settled it" — it's
   a reporting-time join, not a claim/settlement mechanism.
2. **Query shape.** Project cost/revenue reporting
   (`src/domain/projects/profitability-service.ts`) needs a plain indexed
   join from `invoice_lines`/`bill_lines`/`expense_claim_lines` straight to
   a project id. The dimension system tags *posted `journal_lines`*, one
   level removed from the invoice/bill/expense-claim line a human actually
   edits and a project needs to attribute — using it here would mean
   re-deriving "which invoice line" from "which journal line" through an
   extra join, for no benefit.
3. **A project is a first-class entity**, not an open-ended tag — it has
   its own lifecycle (budget, status, tasks, a billing rate) that needs a
   real table with real columns, not a `dimension_value` row with
   side-tables bolted on.

The dimension system remains the right tool for open-ended, user-defined
tags (cost centre, region, department) with no entity of their own behind
them. `projectId` is the right tool for a specific, structural, already-
modeled business concept the domain layer reasons about directly. Both
mechanisms now coexist in this schema, each used for the shape of problem
it fits.

## 2j. Phase 7 Slice 2: `products`, `inventory_movements`, `inventory_adjustments`

Three new tables for Inventory (master spec §20/§21, scoped down hard —
see `docs/roadmap.md`'s Phase 7 Slice 2 entry and
`docs/accounting-engine.md` §10 for the perpetual-inventory/COGS posting
convention). `src/domain/inventory/`'s own doc comments have the full
design; this is the schema-level summary.

- `products` — `organizationId`, a unique-per-org `sku`, `name`,
  `description`, `type` (`TRACKED_INVENTORY`/`NON_INVENTORY`/`SERVICE` —
  the latter two share the exact same catalog and line-item UI as a
  tracked product but never touch a movement, a quantity, or a COGS
  posting), `costingMethod` (an enum with a single value,
  `WEIGHTED_AVERAGE`, today — see §10's reasoning for why FIFO is a future
  enum value, not a future column), `sellPrice` (a UI prefill only, never
  authoritative), `revenueAccountId` (always required), `purchaseAccountId`
  (required for `NON_INVENTORY`/`SERVICE`, null for `TRACKED_INVENTORY`),
  `inventoryAssetAccountId`/`cogsAccountId` (required for
  `TRACKED_INVENTORY`, null otherwise), `quantityOnHand`/`averageUnitCost`
  (the perpetually-maintained current state — the authoritative numbers,
  never recomputed by replaying `inventory_movements`), and
  `reorderPoint`/`reorderQuantity`/`preferredSupplierContactId` for
  `ReorderAlertService`.
- `inventory_movements` — the append-only audit trail: `productId`,
  `movementType` (`PURCHASE`/`SALE`/`ADJUSTMENT`), a signed
  `quantityDelta`, the `unitCost` this movement was valued at, its signed
  `totalValue`, and `balanceQuantityAfter`/`balanceAverageCostAfter` — a
  post-movement snapshot kept purely for audit transparency, not as the
  source of truth (that's `products` itself, updated under a
  `SELECT ... FOR UPDATE` row lock in the same transaction — see
  `InventoryService`'s doc comment). Exactly one of
  `invoiceLineId`/`billLineId`/`adjustmentId` is set, matching
  `movementType`; `journalEntryId` points at the invoice's/bill's/
  adjustment's own posted entry (never a separate one for a SALE/PURCHASE
  — see §10).
- `inventory_adjustments` — a manual correction: `productId`, signed
  `quantityDelta`, the `unitCost` it was valued at, a required `reason`,
  the `adjustmentAccountId` chosen by whoever recorded it, and its own
  `journalEntryId`.

An optional `productId` was added directly to `invoice_lines` and
`bill_lines` — the same dedicated-FK decision §2i above documents for
`projectId`/`taskId`, for the same reasons: a sale/purchase needs a
*structural* link the posting code reads to decide whether to move stock
at all and which accounts to resolve onto, not just a reporting-time tag.
The dimension system remains the tool for open-ended user-defined tags;
`productId` is the tool for this specific, structural, already-modeled
business concept.

## 2k. Phase 7 Slice 3: `fixed_asset_classes`, `fixed_assets`, `depreciation_entries`

Three new tables for Fixed Assets (master spec §28, scoped down — see
`docs/roadmap.md`'s Phase 7 Slice 3 entry and `docs/accounting-engine.md`
§11 for the depreciation/disposal posting conventions).
`src/domain/fixed-assets/`'s own doc comments have the full design; this is
the schema-level summary.

- `fixed_asset_classes` — `organizationId`, `name`, `defaultDepreciationMethod`
  (an enum with a single value, `STRAIGHT_LINE`, today — same reasoning as
  `inventoryCostingMethodEnum` for FIFO), `defaultUsefulLifeMonths`,
  `isActive`. A simple per-org lookup/template, never re-consulted after an
  asset copies its defaults at registration time.
- `fixed_assets` — `organizationId`, `assetClassId`, `name`/`description`,
  `acquisitionDate`/`acquisitionCost`, `usefulLifeMonths` (months, not
  years — the one consistent unit this slice uses, so a sub-year life is
  representable exactly), `depreciationMethod`, `residualValue`, `status`
  (`ACTIVE`/`DISPOSED`/`WRITTEN_OFF` — the latter two terminal, no path
  back), the three GL accounts it posts to (`assetAccountId`,
  `accumulatedDepreciationAccountId`, `depreciationExpenseAccountId`),
  `accumulatedDepreciation` (the perpetually-maintained running total — the
  authoritative number, never recomputed by replaying
  `depreciation_entries`, same convention as `products.quantityOnHand`),
  `locationReference`/`serialNumber`, an optional `sourceBillLineId`
  traceability link, and `disposedAt`/`disposalProceeds`/
  `disposalGainLoss`/`disposalJournalEntryId` (all null while `ACTIVE`).
  `accumulatedDepreciationAccountId` points at an ordinary `ASSET`-type
  account carrying a credit balance (this schema has no dedicated
  contra-asset account type) — the same convention
  `InventoryValuationService`'s reconciliation relies on for that balance
  to come out negative when normal-signed.
- `depreciation_entries` — the append-only per-asset-per-period audit
  trail: `assetId`, `periodStart`/`periodEnd` (the first/last calendar day
  of the depreciated month), `amount` (that period's charge, possibly
  `0`), `accumulatedDepreciationAfter` (a post-entry snapshot, kept purely
  for audit transparency, same convention as
  `inventory_movements.balanceQuantityAfter`), and `journalEntryId` (null
  for a `$0` row, otherwise the one combined entry
  `DepreciationService.runForPeriod` posted for that whole run — never a
  separate entry per asset). The `UNIQUE (organizationId, assetId,
  periodStart)` index is this slice's idempotency guarantee: a given
  asset/month pair can be inserted at most once, full stop — see §11.

No new column was added to `bill_lines`/`invoice_lines` for this slice —
unlike Phase 7 Slices 1/2's `projectId`/`productId`, a fixed asset's link
back to its acquiring bill line is a single FK the other direction
(`fixed_assets.sourceBillLineId`), since at most one asset is ever
registered from a given bill line, never the reverse fan-out `projectId`/
`productId` needed.

## 2l. Phase 9 Slice 1: `budgets`, `budget_lines`

Two new tables for budgeting (master spec §36, scoped down — see
`docs/roadmap.md`'s Phase 9 Slice 1 entry). Both are pure planning data:
neither has a `journalEntryId`, and nothing in `src/domain/budgeting/`
calls `PostingService`.

- `budgets` — `organizationId`, `name`, `type`
  (`BASELINE`/`REVISED_FORECAST`/`ROLLING_FORECAST`), `status`
  (`DRAFT`/`ACTIVE`/`ARCHIVED`), a fixed `periodStart`–`periodEnd` range,
  an optional self-referencing `sourceBudgetId` (set only for a budget
  created via `BudgetService.createRollingForecast`, traceability only),
  and `carryForwardAfterDate` (the cutoff used to create it, also
  traceability only — never re-read to recompute anything).
- `budget_lines` — `organizationId`, `budgetId`, `accountId`, an optional
  `dimensionValueId` (reusing Phase 5 Slice 2's `dimension_values` rather
  than a parallel tagging mechanism), `periodStart`/`periodEnd` (one
  calendar month per row), and `amount` (normal-balance-signed, same
  convention `normalSignedBalance` produces for actual activity, so a
  budget line and the actual figure it's compared against need no
  sign-flipping anywhere in the reporting layer).

**Design decision: no DB-level uniqueness constraint on (budget, account,
dimension value, month).** Every other append-only or per-period table in
this schema (e.g. `depreciation_entries`' `UNIQUE (organizationId,
assetId, periodStart)`) enforces its own "at most one row" rule with a
unique index. `budget_lines` can't use that same pattern directly:
`dimensionValueId` is nullable, and Postgres treats every `NULL` as
distinct from every other `NULL` in a unique index, so `UNIQUE
(budgetId, accountId, dimensionValueId, periodStart)` would silently allow
two rows for "this account, no dimension, this month" — the exact
duplicate it's meant to prevent. Two structural alternatives were
considered and rejected: a generated/sentinel non-null column standing in
for "no dimension" (works, but introduces a magic value every reader of
this table has to know about forever, for a problem the application layer
already has to solve for the *values* within one call anyway), and a
partial unique index (`WHERE dimension_value_id IS NULL` plus a second
index for the non-null case) — workable, but two indexes to express one
rule, against a table whose only writer is one service method. Instead,
`BudgetService.setAccountLines` enforces it directly: every bulk-entry
save deletes the existing rows for that exact (budget, account, dimension)
combination across the submitted months and re-inserts the new set, in
the same transaction — structurally never a duplicate because nothing else
ever writes to this table. If a second write path to `budget_lines` is
ever added, this choice should be revisited.

## 3. Row-Level Security

Every tenant table gets an RLS policy of the shape:

```sql
alter table accounts enable row level security;
alter table accounts force row level security;
create policy tenant_isolation_accounts on accounts
  using (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
```

`withTenant()` sets `app.current_org_id` via `set_config(..., true)` —
transaction-local, equivalent to `SET LOCAL` — inside each request's
transaction (`src/db/tenant.ts`), using the org resolved from the
authenticated session, never a client-supplied header or body value.

Two details that are load-bearing rather than stylistic:

- `nullif(..., '')` because an unset custom GUC reads back as the empty
  string, not NULL, and `''::uuid` raises rather than simply matching no
  rows.
- `FORCE` (migration `0002`) because PostgreSQL exempts a table's owner from
  its own policies — see `docs/security.md` §2.

RLS is hand-authored SQL in `drizzle/0001_row_level_security.sql` and
`drizzle/0002_force_row_level_security.sql`; Drizzle's schema DSL does not
model policies, so they live in migrations, version-controlled like any
other.

## 4. Why Drizzle over Prisma or an ORM tied to Supabase

See `decisions/0001-database-orm.md`. Short version: Drizzle gives typed
migrations and a typed client while remaining plain PostgreSQL underneath —
`DATABASE_URL` can point at Supabase Postgres, a local Postgres, or any
other Postgres, satisfying "the database should remain portable Postgres".
Prisma was the original choice; its engine binaries could not be fetched in
the build environment, and the portability requirement made Drizzle a
straight swap.

## 5. What's deferred

Sales (`Invoice`, `Payment`), purchases (`Bill`, `PurchaseOrder`), inventory,
payroll, budgets, and everything else in the master spec's entity list
(§62) are modeled in later phases, each with its own ledger-posting
consequence documented before implementation, per master spec §84/§85
("financial features additionally require correct ledger consequence").
Within Phase 2 itself, a live bank feed provider, AI-assisted fuzzy
reconciliation, document AI (receipt/invoice capture), expense management,
object storage, a background job queue, and a cache are not yet built — see
`docs/roadmap.md`.
