# Roadmap

Source of truth for scope: the master build prompt (accounting + banking +
payroll + tax + billing + payments + expenses + inventory + projects + CRM +
forecasting + reporting + AI automation + practice management, per its §82
phase breakdown). This file tracks what is actually built vs. planned so
"done" claims stay honest.

## Phase 1 — Financial Foundation — **complete**

- [x] Docs: architecture, accounting engine, database, security, AI agents,
      roadmap, decision records
- [x] App scaffold: Next.js (TS strict, Tailwind, shadcn/ui), layered dirs
- [x] Drizzle schema: orgs, memberships, accounts, fiscal periods, journals,
      journal lines, dimensions, contacts, currencies, tax codes, audit log
- [x] Double-entry posting engine (`LedgerService`/`PostingService`) +
      unit + property-based tests
- [x] Auth (NextAuth credentials) + org membership + RBAC permission checks
- [x] AuditService wired into account/journal/contact/membership mutations
- [x] Dashboard shell + role-aware navigation
- [x] Chart of Accounts UI, Journal Entry UI (create/post/reverse), Trial
      Balance report
- [x] Northstar Electrical Group demo seed data (28 journal entries incl.
      one reversal, across a full AU electrical-contractor chart of
      accounts)
- [x] Tenant isolation integration test (RLS backstop, verified even when
      application code forgets a tenant filter)
- [x] `npm run typecheck`, `npm run lint`, `npm test` (38 tests) and
      `npm run build` (production build) all pass; the built app was
      smoke-tested end-to-end in a real browser (register/login/post a
      journal entry/reverse it/trial balance), not just type-checked
- [ ] MFA/passkey auth — deferred (noted in `security.md`)
- [ ] **Set `DATABASE_CA_CERT` for the production database** — TLS is on for
      hosted connections but the server certificate is not verified without
      it (`docs/security.md` §4a). Required before real financial data.
- [ ] Period-lock override workflow UI — reject path enforced, override
      workflow deferred to Phase 9 (Close)

## Phase 2 — Money (in progress)

Built as a sequence of complete vertical slices per master spec §82, not all
at once — see `docs/decisions/0006-bank-feed-abstraction.md`.

### Slice 1 — Bank import, reconciliation, bank rules — **complete**

- [x] Schema: `bank_accounts`, `bank_import_batches`, `bank_transactions`,
      `bank_rules`, each RLS-enabled and FORCEd, `mm_app`-granted (verified
      by the `db:migrate` tenant-isolation audit)
- [x] Bank feed provider abstraction: `ParsedStatementRow` is
      provider-agnostic; `MANUAL` (file upload) is the only provider today,
      a live feed is additive later
- [x] CSV import — auto-detects Date/Description/Amount or Debit/Credit
      columns, or an explicit mapping; handles quoted fields, currency
      symbols, parenthesized negatives, DD/MM/YYYY vs MM/DD/YYYY
- [x] OFX import — both the SGML (1.x, unclosed leaf tags) and XML (2.x)
      variants
- [x] QIF import
- [x] Idempotent import: a stable `externalId` (provider id or content
      hash) per bank account means re-importing a file, or an overlapping
      live-feed sync later, inserts nothing already on file
- [x] Bank rules: priority-ordered, description/amount conditions,
      auto-categorize on import
- [x] Deterministic reconciliation matching with a plain-language
      explanation per candidate (`ReconciliationService.findCandidateMatches`)
- [x] Post a new balanced journal entry from an uncategorized transaction,
      or match to an existing posted line — both go through
      `PostingService`, so every Phase 1 invariant still applies
- [x] UI: link a bank account, import a statement, reconcile (categorize +
      post / confirm a suggested match / exclude), manage bank rules
- [x] `npm run typecheck`, `npm run lint`, `npm test` (155 tests) and
      `npm run build` all pass; smoke-tested end-to-end in a real browser
      (register → link account → import CSV → post → Trial Balance
      reflects it → re-import is a no-op → create a bank rule)

### Slice 2 — scoped down, partially complete

The original scope (`docs/decisions/0006-bank-feed-abstraction.md` and the
line above, kept for history) bundled a live bank feed provider,
AI-assisted fuzzy reconciliation, document AI, expense management, object
storage, background jobs, a Redis cache, and Stripe into one slice. Building
that in full would mean either faking external accounts this environment
doesn't have, or shipping shallow stubs — both against master spec §82/§85.
The user explicitly deferred the parts that need real external
accounts/credentials; everything else is built to the same bar as every
other slice.

**Built:**
- [x] AI-assisted fuzzy reconciliation (`FuzzyReconciliationService`,
      `src/domain/banking/fuzzy-reconciliation-service.ts`): a user-triggered
      ("Get AI suggestions") second pass over transactions with no
      exact-amount deterministic candidate — widens `findCandidateMatches`'s
      exact-amount/±10-day window to a near-amount (±20%) / ±30-day pool of
      journal lines, plus a list of active GL accounts to categorize
      against, and asks Claude to rank plausible matches with a
      plain-language reason via a schema-constrained tool call, re-validated
      with zod. Every returned id is checked against the actual candidate
      pool the model was given — an id it merely claims is never trusted.
      Never posts or confirms anything itself; every suggestion still goes
      through the existing `confirmMatch`/`createJournalFromTransaction`
      paths a human clicks. New `bank_transaction:ai_suggest` permission.
      Silently falls back to "no AI section, deterministic candidates only"
      on a missing `ANTHROPIC_API_KEY`, a failed/timed-out call, or a schema
      validation failure — see `docs/ai-agents.md`
- [x] Document AI receipt/invoice capture (`src/domain/documents/`):
      `AiReceiptExtractor` sends an uploaded image or PDF to Claude with
      vision, via a schema-constrained tool call extracting
      `{supplierName, date, subtotal, taxAmount, total, currency,
      lineItems, suggestedCategory, confidence, reasoning}`, zod-validated.
      Reachable from `/[orgSlug]/expenses/capture`. Never silently posts —
      the result only ever pre-fills an editable draft expense claim
      (`/[orgSlug]/expenses/new?receiptId=...`) that a human reviews and
      confirms; a missing API key or failed call still lets the upload
      succeed with a blank draft. File storage is bytea in Postgres (the
      `uploaded_receipts` table) behind a small `DocumentStorageProvider`
      interface — a deliberate, temporary decision, see
      `docs/decisions/0007-document-storage-bytea.md`. 10MB size limit,
      server-side MIME allowlist (JPEG/PNG/WebP/GIF/PDF). Not yet wired into
      the Purchases/bill-capture side mentioned in the original scope — the
      extraction service and storage are equally usable there, but only the
      expense-claim integration was built this slice
- [x] Expense management (master spec §19): `expense_claims`/
      `expense_claim_lines` tables (RLS-enabled and FORCEd, `mm_app`-granted
      — verified by the `db:migrate` tenant-isolation audit, 27 of 31
      tables now organization-scoped). `ExpenseClaimService`
      (`src/domain/expenses/expense-claim-service.ts`, the mirror of
      `BillService`): draft (with lines, computed subtotal/tax/total via
      `expense-claim-calculations.ts`, never floating point) → submit →
      approve (posts: debit each line's expense account + tax input-credit
      account, credit an "Employee Reimbursements Payable" liability, via
      `PostingService.postJournal`) or reject (no ledger effect) → mark
      reimbursed (a second journal debiting the payable and crediting the
      paying bank account — kept separate from approval the same way
      bills/invoices separate posting from payment) → void (reverses the
      approval journal via `PostingService.reverseEntry`, refused once
      reimbursed). New permissions `expense_claim:read/manage/approve`,
      `expense_receipt:manage`, wired into every role (every role can
      create/submit their own claims; approval needs a manager-level role —
      a simple single-approver workflow, the full amount-tiered approval
      engine is Phase 9/10, out of scope here). UI under
      `/[orgSlug]/expenses` (list filtered to "mine" for non-approvers,
      create/edit draft with lines and optional receipt capture,
      submit/approve/reject/mark-reimbursed/void), added to nav under
      Purchases per master spec §59
- [x] `npm run typecheck`, `npm run lint`, `npm test` (298 tests) and
      `npm run build` all pass; smoke-tested end-to-end against a real local
      Postgres and a running production server (`next start`) driven via
      raw HTTP (React Server Action form submissions): register → chart of
      accounts (payable liability, expense, bank asset) → create a draft
      expense claim → submit → approve & post → Trial Balance reflects the
      $110 debit/credit exactly → mark reimbursed → Trial Balance shows the
      payable back at $0 and the bank account down $110; separately,
      imported a bank transaction with no exact-amount candidate and
      confirmed the "Get AI suggestions" affordance renders and, with no
      `ANTHROPIC_API_KEY` configured, resolves silently to the
      deterministic-only view with no error and no AI section

**Explicitly still not started, named plainly rather than dropped silently:**
- [ ] **Live bank feed provider** (Basiq, most likely — AU open banking).
      The abstraction point already exists and is unchanged by this slice:
      `bankAccounts.provider`/`externalAccountId` and
      `ParsedStatementRow` (see `docs/decisions/0006-bank-feed-abstraction.md`)
      mean a live provider is an additive `BankFeedProvider` implementation
      later, not a rework of import/reconciliation. Needs a real Basiq
      account and API credentials this environment doesn't have
- [ ] **Stripe** (billing/payments). No abstraction point built yet; needs a
      real Stripe account and API keys
- [ ] **Background job queue.** Needed for anything that shouldn't block a
      request (e.g. a live feed sync, a scheduled `OVERDUE` status sweep —
      see the `invoice_status`/`bill_status` enum doc comments in
      `src/db/schema.ts` for why "overdue" is computed at read time instead).
      No queue infrastructure (e.g. a hosted queue or a self-hosted worker)
      is available in this environment yet
- [ ] **Redis-compatible cache.** Nothing in this codebase depends on it yet;
      would need a real Redis-compatible instance to build against
      meaningfully rather than an untested abstraction

## Onboarding wizard (cross-cutting UX slice) — **complete**

Not one of the master-spec §82 numbered phases — a UX slice that makes
Phase 1's chart of accounts and Phase 2 Slice 1's bank linking actually
reachable for a brand-new organization, which otherwise starts with only
the two starter system equity accounts (see `OrganizationService`) and
hits "No ASSET accounts exist yet" the moment it tries to link a bank
account. Also reachable from an existing organization that registered
before this shipped.

- [x] `/[orgSlug]/onboarding`: a 4-step wizard (business basics → AI-assisted
      chart-of-accounts recommendation → confirm & create → link first bank
      account → done), gated on the new `onboarding:manage` permission
      (OWNER/ADMINISTRATOR only, see `src/domain/permissions/roles.ts`)
- [x] Curated, versioned chart-of-accounts template library
      (`src/domain/onboarding/chart-of-accounts-templates.ts`): Trades &
      Contracting, Professional Services, Retail & E-commerce, Hospitality,
      General — realistic AU-style accounts in the spirit of the Northstar
      seed data, parameterized by `sellsGoods`/`sellsServices`/
      `hasEmployees`/`tracksInventory`
- [x] Classify-then-expand AI integration (`@anthropic-ai/sdk`,
      `claude-haiku-4-5-20251001` by default, overridable via
      `ANTHROPIC_ONBOARDING_MODEL`): the model only ever picks a
      `templateKey` + those 4 booleans via a schema-constrained tool call,
      validated with zod before use — it never emits an account code or
      name. See `docs/ai-agents.md` for why this shape is non-negotiable
- [x] Mandatory, fully-tested deterministic fallback
      (`DeterministicRecommender`, keyword-based): used automatically
      whenever `ANTHROPIC_API_KEY` is unset, the API call fails/times out,
      or the response fails schema validation — the wizard always works
      with zero network access, and this is the only path exercised in
      CI/tests
- [x] Editable live preview before anything is created (grouped by account
      type, collapsible, add/remove accounts) — nothing touches the ledger
      until the user confirms
- [x] Every account created through `AccountService.create` (never a direct
      table write); safely re-runnable/resumable — accounts that already
      exist (by code) are skipped, never duplicated or recreated, including
      on an organization that already has some accounts
- [x] Audit: `onboarding.chart_of_accounts_applied` records the template
      key, flags, created/skipped account codes, and (when applicable) the
      AI recommendation's model, confidence and reasoning — not just "accounts
      were created"
- [x] Registration redirects straight into the wizard instead of the bare
      dashboard; existing organizations with no real chart of accounts see a
      "Finish setting up your chart of accounts" banner on the dashboard
      linking to the wizard
- [x] `npm run typecheck`, `npm run lint`, `npm test` (188 tests, including
      the deterministic classifier, template expansion per flag
      combination, AI schema-validation failure → fallback with a mocked
      SDK, and a full wizard-flow integration test against the real test
      database) and `npm run build` all pass
- [ ] Deferred, explicitly out of scope for this slice (see the master
      spec's fuller §60 onboarding flow): live bank feed connection, data
      migration/import from other software, invoice template customization,
      team invites during onboarding, tax registration workflows beyond the
      country/currency picked in step 1

## Phase 3 — Sales (in progress)

### Slice 1 — Customer invoicing & AR core — **complete**

- [x] Schema: `invoices`, `invoice_lines`, `payments`, `payment_allocations`
      (plus a `payable_account_id` column added to `tax_codes`), each RLS-
      enabled and FORCEd, `mm_app`-granted (verified by the `db:migrate`
      tenant-isolation audit — 20 of 24 tables now organization-scoped)
- [x] `InvoiceService` (`src/domain/sales/invoice-service.ts`): create/edit/
      delete a draft invoice with computed line/tax/subtotal/total (never
      floating point — `src/domain/sales/invoice-calculations.ts`);
      approve-and-post debits the invoice's AR control account and credits
      each line's revenue account plus each tax code's payable account, all
      through `PostingService.postJournal` — never a direct `journal_lines`
      write, so every Phase 1 invariant (balance, period-lock, immutability)
      still applies; void reverses the posting journal via
      `PostingService.reverseEntry` rather than editing the original
      (refused while any payment is still allocated)
- [x] `PaymentAllocationService` (`src/domain/sales/payment-service.ts`):
      records a customer receipt and allocates it across one or more
      invoices in one transaction, posts the ledger effect (debit deposit
      account, credit each allocated invoice's AR account) via
      `PostingService`, and recomputes each invoice's PART_PAID/PAID status
      from `payment_allocations` (never a denormalized counter). Enforces
      explicitly: an allocation can never exceed its invoice's outstanding
      balance, and a payment's allocations can never exceed the payment's
      own amount
- [x] `AgedReceivablesService` (`src/domain/sales/aged-receivables-service.ts`):
      current/1-30/31-60/61-90/90+ buckets per customer per master spec §32,
      computed from `dueDate` and live allocation totals (no stored
      "overdue" status/background job — see the `invoice_status` enum's
      doc comment in `src/db/schema.ts`)
  - [x] New permissions: `customer_invoice:read/manage/post/void`,
      `customer_payment:read/manage`, wired into the existing
      `ROLE_PERMISSIONS` matrix (ACCOUNTS_RECEIVABLE gets full access,
      matching its name; MANAGER/READ_ONLY get read-only)
- [x] `AuditService` wired into every invoice/payment mutation
- [x] UI under `/[orgSlug]/sales`: dashboard, invoice list (status filter)
      and create/edit/detail (post/void/record-payment actions), a minimal
      customers list/create/detail (Contacts had no UI yet in Phase 1;
      Phase 3 needed one to select an invoice's customer), Aged Receivables
      report with drill-down links to invoices — added to the role-aware
      nav under "Sales" per master spec §59. The Tax Codes page gained a
      "payable account" field (`src/app/[orgSlug]/accounting/tax-codes`),
      required before a tax code can be used on an invoice line
- [x] Tests: unit (`src/tests/unit/sales/invoice-calculations.test.ts` — 11
      cases incl. Decimal-exact tax rounding), property-based
      (`src/tests/property/sales/*` — every approved invoice's journal
      balances; payment allocation accept/reject always matches the
      arithmetic truth), integration (`src/tests/integration/sales/
      invoice-and-payments.test.ts` — 12 cases: draft → approve/post →
      trial balance reflects it → full/partial payment → status updates →
      multi-invoice allocation → void/credit-note path → double-post
      rejected → over-allocation rejected), and a tenant-isolation case
      added to the existing suite
- [x] `npm run typecheck`, `npm run lint`, `npm test` (183 tests) and
      `npm run build` all pass; smoke-tested end-to-end against a real
      local Postgres and a running dev server driven via raw HTTP (React
      Server Action form submissions, not a browser — see the session
      notes for this slice): register → create chart-of-accounts entries
      and a tax code with a payable account → add a customer → create a
      draft invoice → approve & post it → Trial Balance reflects the
      debit/credit exactly → record a full payment → invoice status
      becomes PAID and the bank account balance updates → a second
      invoice's void correctly reverses its journal
- Deferred to later Sales slices (explicitly out of scope for this one):
  quotes, recurring/progress/milestone invoicing, the customer portal,
  smart debt collection, a dedicated full Contacts/CRM UI (Phase 3 Slice 1
  added only the minimal customer list/create/detail invoicing needs)

### Slice 2 — Quotes, recurring invoicing, collection priority — **complete**

Scoped down from the full "quotes, recurring/progress/milestone invoicing,
customer portal, smart debt collection" deferral above — see the explicit
deferrals at the end of this section for why progress/milestone invoicing,
the customer portal, and AI-drafted collection reminders are each a
separate, later piece of work rather than a rushed shortcut here.

- [x] **Quotes.** Schema: `quotes`, `quote_lines` (RLS-enabled and FORCEd,
      `mm_app`-granted, verified by the `db:migrate` tenant-isolation audit
      — 32 of 36 tables now organization-scoped). Shaped like
      `invoices`/`invoice_lines` on purpose:
      `QuoteService`(`src/domain/sales/quote-service.ts`) reuses
      `calculateInvoiceTotals` verbatim rather than duplicating the line/
      tax/total math. Status flow `DRAFT → SENT → ACCEPTED/DECLINED`, then
      `ACCEPTED → CONVERTED`. A quote never calls `PostingService` and has
      no `journalEntryId` at all — it's pre-sale, not a financial
      transaction. The killer feature, `QuoteService.convertToInvoice`,
      copies the quote's customer and every line's description/quantity/
      unit price/account/tax code onto a brand-new **draft** invoice via
      `InvoiceService.create` — the exact same call path a manually created
      invoice uses, never a parallel/shortcut posting route — so the
      resulting invoice still needs its own separate approval and posting.
- [x] **Recurring invoicing.** Schema: `recurring_invoice_templates`,
      `recurring_invoice_template_lines`, `invoice_recurring_source` (same
      RLS treatment). `RecurringInvoiceService`
      (`src/domain/sales/recurring-invoice-service.ts`) holds a customer,
      line items, and a schedule (weekly/monthly/quarterly/annually, start
      date, optional end date/occurrence cap). **There is no background job
      queue** — Phase 2 Slice 2 explicitly deferred that infrastructure —
      so `generateDue` is a manually-triggered "Generate due invoices"
      action (reachable by OWNER/ADMINISTRATOR/ACCOUNTS_RECEIVABLE, and
      ACCOUNTANT/BOOKKEEPER, matching the existing `customer_invoice:manage`
      role pattern) that finds every active template with
      `nextRunDate <= today`, generates a normal **DRAFT** invoice per due
      occurrence via `InvoiceService.create` (never auto-approved or
      auto-posted — a human still reviews and posts each one), and advances
      `nextRunDate` past that occurrence in the same step — so running the
      action twice on the same day is a no-op the second time, and a
      template that hasn't been run in a while catches up on every missed
      occurrence rather than just the most recent one. **This is explicitly
      the manually-triggered precursor to real scheduling, not a fake
      automation** — once Phase 2 Slice 2's job-queue gap is filled, the
      same `generateDue` logic can be called from a scheduled worker instead
      of a button with no change to its invariants.
- [x] **Collection Priority Score (the deterministic core of "smart debt
      collection").** `calculateCollectionPriorityScore`
      (`src/domain/sales/collection-priority.ts`) is a pure, unit-tested
      0–100 score per overdue invoice from master spec §15's formula
      inputs — invoice amount, days overdue, and the customer's historical
      average payment time (derived from that customer's own already-PAID
      invoices' settlement dates vs. their due dates, `null` when there's
      no history yet, scored as neutral risk rather than as either extreme).
      `AgedReceivablesService.getWithPriority` extends the existing Aged
      Receivables data (rather than duplicating the aging computation) with
      this score, sorted highest-priority first, surfaced as a new "Who to
      chase first" table on top of the existing Aged Receivables report.
- [x] New permissions: `customer_quote:read/manage`,
      `recurring_invoice:read/manage`, following the existing
      `customer_invoice:*` naming convention, wired into `ROLE_PERMISSIONS`
      the same way (ACCOUNTS_RECEIVABLE/ACCOUNTANT/BOOKKEEPER get full
      access, MANAGER/READ_ONLY get read-only)
- [x] `AuditService` wired into every quote/template mutation and every
      generated invoice
- [x] UI under `/[orgSlug]/sales`: Quotes list/create/edit-draft/detail
      (send/accept/decline actions, and a prominent "Convert to invoice"
      action once accepted), Recurring Invoices list (with the "Generate
      due invoices" action and a due-count indicator) and create/edit/
      detail (pause/resume/delete), and a "Who to chase first" table added
      to the existing Aged Receivables page — all added to the role-aware
      nav under "Sales"
- [x] Tests: unit (`recurring-schedule.test.ts` — next-run-date advancement
      across all four frequencies incl. month-end clamping and leap-year
      handling; `collection-priority.test.ts` — score ordering and edge
      cases), property-based
      (`quote-conversion-balance.property.test.ts` — every accepted quote's
      converted-and-posted invoice still balances, for arbitrary quote
      shapes, proving the `InvoiceService` composition holds), integration
      (`sales/quotes.test.ts` — full DRAFT→SENT→ACCEPTED→CONVERTED flow incl.
      decline and double-convert rejection; `sales/recurring-invoices.test.ts`
      — generation, no-double-generation same day, catch-up across missed
      periods, `maxOccurrences`/`endDate` cutoffs, pause; `sales/
      collection-priority.test.ts` — seeded customers with different payment
      histories rank correctly), and two new tenant-isolation cases (quotes,
      recurring templates)
- [x] `npm run typecheck`, `npm run lint`, `npm test` (335 tests) and
      `npm run build` all pass; smoke-tested end-to-end against a real local
      Postgres and a running dev server driven via raw HTTP (React Server
      Action form submissions): created a quote, sent it, accepted it,
      converted it to a draft invoice with the customer/lines copied across
      untouched, approved and posted that invoice, confirmed the resulting
      journal balances (`SUM(debit) = SUM(credit) = 1000.0000`) and the
      invoice's own status; separately created a recurring monthly template
      dated in the past, ran "Generate due invoices" once to produce four
      correctly-dated DRAFT invoices (none posted, none auto-approved) and
      advance `nextRunDate` to the next unbilled period, then ran it again
      the same day and confirmed zero invoices were generated the second
      time; confirmed the "Who to chase first" table renders on Aged
      Receivables
- **Deferred, explicitly, with reasons (not silently dropped):**
  - **Progress/milestone invoicing** — a distinct billing model tied to
    projects/jobs, which don't exist in this codebase yet (Phase 7:
    Operations). Recurring invoicing is the more common, higher-value case
    for the businesses this product targets today; progress/milestone
    billing doesn't have a sensible home until projects do.
  - **Customer portal** — needs unauthenticated/customer-authenticated
    external access, a fundamentally different auth model from the internal
    org-member NextAuth flow this app has, plus e-signature and external
    payment collection UI. It is a customer-facing surface that must never
    leak cross-tenant data — real security-design work deserving its own
    slice, not a shortcut bolted onto this one.
  - **AI-drafted, tone-tiered collection reminder emails/sequences** — the
    deterministic Collection Priority Score above is built and shown; the
    AI-drafting half of master spec §15 needs an actual outbound email
    integration (Gmail/Outlook connectors per the master spec), which this
    codebase has no wiring for at all. A distinct, larger feature better
    scoped on its own once that integration exists.
  - A scheduled/automatic version of "Generate due invoices" — needs the
    background job-queue infrastructure Phase 2 Slice 2 deferred. The
    manually-triggered action built here is its precursor: same
    `RecurringInvoiceService.generateDue` logic, just not yet callable from
    a worker on a timer.

## Phase 4 — Purchases — **complete** (core + one extension slice)

### Slice 1 — Suppliers & Accounts Payable core — **complete**

- [x] Schema: `bills`, `bill_lines`, `supplier_payments`,
      `supplier_payment_allocations` (plus a `receivable_account_id` column
      added to `tax_codes`, the input-tax-credit mirror of Phase 3's
      `payable_account_id`), each RLS-enabled and FORCEd, `mm_app`-granted
      (verified by the `db:migrate` tenant-isolation audit — 24 of 28 tables
      now organization-scoped). Suppliers are not a new table: `contacts`
      already carried a `kind` enum (`CUSTOMER`/`SUPPLIER`/`BOTH`) from
      Phase 1, so this slice reuses `ContactService` and its RLS as-is,
      exactly the way Phase 3 reused it for customers
- [x] `BillService` (`src/domain/purchases/bill-service.ts`, the mirror of
      `src/domain/sales/invoice-service.ts`): create/edit/delete a draft
      bill with computed line/tax/subtotal/total (never floating point —
      `src/domain/purchases/bill-calculations.ts`); approve-and-post debits
      each line's expense/asset account plus each tax code's *receivable*
      (input tax credit) account and credits the bill's AP control account,
      all through `PostingService.postJournal` — never a direct
      `journal_lines` write; void reverses the posting journal via
      `PostingService.reverseEntry` rather than editing the original
      (refused while any payment is still allocated)
- [x] `SupplierPaymentAllocationService`
      (`src/domain/purchases/supplier-payment-service.ts`): records a
      payment made to a supplier and allocates it across one or more bills
      in one transaction, posts the ledger effect (debit each allocated
      bill's AP account, credit the payment account) via `PostingService`,
      and recomputes each bill's PART_PAID/PAID status from
      `supplier_payment_allocations` (never a denormalized counter).
      Enforces explicitly: an allocation can never exceed its bill's
      outstanding balance, and a payment's allocations can never exceed the
      payment's own amount
- [x] `AgedPayablesService` (`src/domain/purchases/aged-payables-service.ts`):
      current/1-30/31-60/61-90/90+ buckets per supplier per master spec
      §32/§16, computed from `dueDate` and live allocation totals — the
      mirror of `AgedReceivablesService`
- [x] New permissions: `supplier_bill:read/manage/post/void`,
      `supplier_payment:read/manage`, wired into the existing
      `ROLE_PERMISSIONS` matrix (ACCOUNTS_PAYABLE gets full access, matching
      its name; MANAGER/READ_ONLY get read-only)
- [x] `AuditService` wired into every bill/payment mutation
- [x] UI under `/[orgSlug]/purchases` (replacing the Phase-1 "coming soon"
      placeholder): dashboard, bill list (status filter) and
      create/edit/detail (post/void/record-payment actions), a minimal
      suppliers list/create/detail (reusing the Contacts/`ContactService`
      infrastructure Phase 3 built, not a parallel CRM), Aged Payables
      report with drill-down links to bills — added to the role-aware nav
      under "Purchases" per master spec §59. The Tax Codes page gained a
      "receivable account" field alongside Phase 3's "payable account"
      field, required before a tax code can be used on a bill line
- [x] Tests: unit (`src/tests/unit/purchases/bill-calculations.test.ts` — 11
      cases incl. Decimal-exact tax rounding, mirroring the invoice
      calculation tests), property-based (`src/tests/property/purchases/*`
      — every approved bill's journal balances; payment allocation
      accept/reject always matches the arithmetic truth), integration
      (`src/tests/integration/purchases/bill-and-payments.test.ts` — 12
      cases: draft → approve/post → trial balance reflects it →
      full/partial payment → status updates → multi-bill allocation →
      void/credit-note path → double-post rejected → over-allocation
      rejected), and a tenant-isolation case added to the existing suite
- [x] `npm run typecheck`, `npm run lint`, `npm test` (240 tests) and
      `npm run build` all pass; smoke-tested end-to-end against a real
      local Postgres and a running production server (`next start`) driven
      via raw HTTP (React Server Action form submissions, not a browser —
      same approach as Phase 3 Slice 1's smoke test): register → add a
      chart-of-accounts (expense, AP liability, bank asset, GST receivable)
      and a tax code with a receivable account → add a supplier → create a
      draft bill with a taxed line → approve & post it → Trial Balance
      reflects the debit/credit exactly (expense $1,000 dr, GST receivable
      $100 dr, AP $1,100 cr) → record a full payment → bill status becomes
      PAID and AP/bank balances update → a second bill's void correctly
      reverses its journal and AP returns to $0.00 → Aged Payables correctly
      shows nothing outstanding once both bills are settled
- Deferred to later Purchases slices (explicitly out of scope for this
  one, per master spec §82): purchase orders, goods-received matching,
  three-way PO/receipt/invoice matching, recurring bills, supplier credits,
  scheduled/batch payment runs, segregation-of-duties approval workflow for
  payments (creator ≠ approver), document/receipt capture (OCR)

### Slice 2 — Purchase orders, recurring bills, supplier credits, payment runs — **complete**

- [x] Schema: `purchase_orders`/`purchase_order_lines`,
      `purchase_order_receipts`/`purchase_order_receipt_lines`,
      `recurring_bill_templates`/`recurring_bill_template_lines`,
      `bill_recurring_source`, `supplier_credit_notes`/
      `supplier_credit_note_lines`, `supplier_credit_allocations`,
      `payment_runs`/`payment_run_items` — every one RLS-enabled and FORCEd,
      `mm_app`-granted (verified by the `db:migrate` tenant-isolation audit —
      44 of 48 tables now organization-scoped). `bills` gained an optional
      `purchaseOrderId` (set once, by `PurchaseOrderService.convertToBill`,
      never re-pointed) and `bill_lines` gained an optional `receiptId`,
      reusing Phase 2 Slice 2's Document AI receipt capture
      (`src/domain/documents/{receipt-service,receipt-extraction-service}.ts`)
      **as-is** for bill capture — it was already entity-agnostic
      (`uploaded_receipts` has no FK baked in; the link is from the line
      side, exactly like `expense_claim_lines.receiptId`), so no new
      extraction/storage code was needed, only the one new column
- [x] `PurchaseOrderService` + `PurchaseOrderReceiptService`
      (`src/domain/purchases/purchase-order-service.ts`): DRAFT → SENT →
      PARTIALLY_RECEIVED/RECEIVED → CLOSED/CANCELLED, reusing
      `calculateBillTotals` verbatim for line/tax/total math; a PO never
      calls `PostingService` at any point — exactly like a quote, it is pure
      workflow until it becomes a bill. `recordReceipt` is deliberately
      lightweight (no warehouse location, no serial/lot tracking, no
      inventory-asset posting) — a full goods-received workflow needs a real
      inventory module (Phase 7, not built yet); this tracks
      `quantityReceived` per line and derives the PO's own status from it,
      which is what a business without inventory tracking actually needs
- [x] Three-way matching (`src/domain/purchases/three-way-match.ts`): a
      pure, DB-free comparison of a PO line's ordered quantity/price against
      what's been received and what the supplier's bill claims, producing a
      plain-language discrepancy per mismatch (e.g. `"Widgets": ordered
      10.0000, received 10.0000, bill claims 12 — quantity mismatch`).
      `PurchaseOrderService.convertToBill` runs this automatically and
      refuses to proceed on any discrepancy unless the caller explicitly
      passes `acknowledgeDiscrepancies: true` — never a silent auto-accept
      or auto-reject (master spec §16). Conversion always goes through
      `BillService.create`, so the resulting bill is a normal DRAFT that
      still needs its own separate approve-and-post step — a PO conversion
      never auto-posts
- [x] `RecurringBillService` (`src/domain/purchases/recurring-bill-service.ts`):
      structurally identical to `RecurringInvoiceService`, including reusing
      `src/domain/sales/recurring-schedule.ts`'s `advanceRecurringDate`
      **verbatim** rather than duplicating it — the date-advancement math
      (weekly/monthly/quarterly/annually, day-of-month clamping) has nothing
      sales-specific about it. Same on-demand "Generate due bills" trigger
      (no job queue exists yet — see Slice 1's own deferral of this), same
      idempotency guarantee (`nextRunDate` advances past "today" in the same
      step a bill is generated), same rule that every generated bill is a
      normal DRAFT via `BillService.create`, never auto-posted
- [x] `SupplierCreditService` (`src/domain/purchases/supplier-credit-service.ts`):
      a credit note is shaped like a bill (reuses `calculateBillTotals`) and
      posts the mirror image on approval — credit the expense/asset account
      (+ tax input-credit account), debit Accounts Payable — via
      `PostingService.postJournal`. Applying a credit against an outstanding
      bill is a small parallel allocation path
      (`supplier_credit_allocations`) rather than forcing it through
      `SupplierPaymentAllocationService` (a credit isn't a payment — no
      payment account, no bank reconciliation link — so bending that
      service's shape to fit would have been the awkward choice per the
      slice's own guidance). Critically, `BillService.loadAllocatedTotal`
      (the single source of truth for "how much of this bill is settled")
      now sums **both** `supplier_payment_allocations` and
      `supplier_credit_allocations` together, so a bill's outstanding
      balance is always the combined truth — a credit and a later cash
      payment can never independently over-allocate past the bill's total
- [x] `PaymentRunService` (`src/domain/purchases/payment-run-service.ts`):
      groups approved/part-paid bills into one `payment_runs` batch
      (DRAFT → AWAITING_APPROVAL → APPROVED/PAID, org-scoped, tracks
      `createdById`). **Segregation of duties (master spec §52) is enforced
      in the service layer**, not just a UI hint: `approve()` rejects an
      approval attempt where `actor.userId === run.createdById`, throwing
      `SelfApprovalNotAllowedError` — covered by a dedicated integration
      test. The one documented exception: if the organization has at most
      one member holding `payment_run:approve` at all, self-approval is
      allowed and the fact is recorded in the audit trail
      (`selfApprovalDocumented`). This was a deliberate least-bad tradeoff —
      the alternative (blocking it unconditionally) would permanently lock a
      solo or two-person organization out of ever approving a payment, which
      is worse than an audited, narrowly-scoped exception; a real
      multi-person org is never affected by it since it only applies when
      truly only one eligible approver exists. Approval generates the actual
      `supplier_payments` via
      `SupplierPaymentAllocationService.recordPayment` — one call per
      distinct supplier in the run, reusing that existing, tested allocation
      path rather than a shortcut — and re-validates every included bill's
      *current* outstanding balance at approval time (never trusting what
      was captured when the bill was added to the run)
- [x] New permissions: `purchase_order:read/manage`,
      `recurring_bill:read/manage`, `supplier_credit:read/manage/post/void`,
      `payment_run:read/manage/approve`, wired into `ROLE_PERMISSIONS`
      (ACCOUNTS_PAYABLE, ACCOUNTANT, BOOKKEEPER, PAYROLL_MANAGER get full
      access; MANAGER/READ_ONLY get read-only)
- [x] `AuditService` wired into every new mutation, including the
      segregation-of-duties exception path noted above
- [x] UI under `/[orgSlug]/purchases`: Purchase Orders (list/create, detail
      with goods-received recording and a "convert to bill" form that shows
      the three-way-match warning and requires an explicit "proceed anyway"
      checkbox before it will create the bill), Recurring Bills (list/create,
      detail with pause/resume, a "Generate due bills" action), Supplier
      Credits (list/create, detail with post/apply-to-bill/void), Payment
      Runs (list/create — pick bills, defaults to full outstanding balance —
      detail with submit-for-approval/approve/cancel, the approval button's
      own error message is the segregation-of-duties rejection when it
      applies) — all linked from the Purchases dashboard and the
      role-aware nav
- [x] Tests: unit (`src/tests/unit/purchases/three-way-match.test.ts` — 7
      cases covering clean matches, quantity-exceeds-received vs.
      quantity-exceeds-ordered, price mismatches, and combinations),
      property-based (`src/tests/property/purchases/supplier-credit-balance.
      property.test.ts` — every posted credit note's journal balances;
      `po-to-bill-balance.property.test.ts` — a bill converted from a
      received PO always balances when posted, whether or not the
      three-way match found a mismatch), integration
      (`src/tests/integration/purchases/purchase-orders.test.ts`,
      `recurring-bills.test.ts`, `supplier-credits.test.ts`,
      `payment-runs.test.ts` — 27 cases total, incl. the PO
      receive→mismatch→acknowledge→post→trial-balance flow, recurring
      generation idempotency, a credit note applied against a bill reducing
      its balance and interacting correctly with a subsequent cash payment,
      and the full segregation-of-duties flow: creator's self-approval
      rejected, a different user's approval succeeds and posts the real
      payments, plus the single-eligible-approver exception), and
      tenant-isolation cases for every new table
- [x] `npm run typecheck`, `npm run lint`, `npm test` (375 tests) and
      `npm run build` all pass; smoke-tested end-to-end against a real local
      Postgres and a running production server (`next start`): logged in via
      the real NextAuth credentials flow (cookie-based session, not a
      bypass) and confirmed every new list/detail page
      (`/purchase-orders`, `/recurring-bills`, `/supplier-credits`,
      `/payment-runs`, each list and one seeded detail page) returns HTTP
      200 with real data rendered — e.g. the payment run detail page
      correctly showed `RUN-000001` with a "paid" status badge. The
      underlying business flow was exercised directly through the same
      domain services the pages call (register → create a PO → mark sent →
      receive 10 units → attempt to convert to a bill claiming 12 units,
      which throws `UnacknowledgedMatchDiscrepancyError` → convert again
      with `acknowledgeDiscrepancies: true`, which succeeds → approve & post
      it, Trial Balance reflects the $660 AP balance exactly → create a
      recurring bill template and generate due bills, re-running the same
      day generates zero more → create a supplier credit, post it, apply it
      to the bill, confirm the bill's status/amountPaid reflects the
      combined credit+cash total → create a payment run as the owner,
      confirm the owner's own approval attempt is rejected
      (`SelfApprovalNotAllowedError`), then approve as a second, genuinely
      different user, confirming the underlying `supplier_payments` posted
      correctly and the bank/AP balances moved). This confirms the real
      HTTP/session/rendering layer works end-to-end for the new pages, not
      only the service layer (which the integration test suite already
      covers exhaustively against the real Postgres instance) — a full
      browser click-through was not additionally performed in this
      environment.
- Deferred, with reasons (not vague hand-waving):
  - **Real bank-file/payment-rail integration** (BECS/ABA file export, real
    bank payment initiation via a banking API) — needs real banking
    credentials/API access not available in this environment, and is a
    substantial integration surface (file format compliance, sandbox
    testing against an actual bank) that deserves its own slice once such
    credentials exist. `PaymentRunService.approve` records the payment in
    the ledger exactly like a manual supplier payment does today — correct
    accounting, just not an actual funds transfer — which is an honest,
    usable subset rather than a stub
  - **Full inventory-backed goods receiving** (warehouse/location tracking,
    serial/lot numbers, an inventory asset account debited on receipt and
    credited on sale/consumption) — needs Phase 7's inventory system, which
    doesn't exist yet. `PurchaseOrderReceiptService` tracks received
    quantity per PO line, which is what a three-way match and a
    without-inventory business need; a true warehouse receiving workflow is
    additive on top of this once Phase 7 exists, not a rework
  - **A job queue driving recurring bills/purchase-order reminders
    automatically** — same deferral as Phase 2 Slice 2/Phase 3 Slice 2's
    recurring invoicing: no background job infrastructure exists yet, so
    "Generate due bills" is a human-triggered action, not a schedule

## Phases 2, 3, and 4 are now all substantially complete

Each has shipped its core slice plus one extension slice (Phase 2:
banking + AI-assisted reconciliation/expenses/documents; Phase 3:
invoicing/AR + quotes/recurring invoicing/collection priority; Phase 4:
bills/AP + purchase orders/recurring bills/supplier credits/payment runs).
Phase 5 (Reporting) is the next phase to start, per master spec §82's
ordering — Phases 2-4 together now cover the full order-to-cash and
procure-to-pay cycles a real small business needs, which is what makes
meaningful financial reporting (P&L, balance sheet, cash flow, aged
schedules across both AR and AP) worth building next rather than earlier.

## Phase 5 — Reporting (in progress)

### Slice 1 — Core financial statements — **complete**

- [x] Shared aggregation query (`src/domain/ledger/gl-aggregation.ts`,
      `sumPostedActivityByAccount`): every account's posted (non-DRAFT)
      debit/credit activity over an optional date range, extracted from
      `LedgerService.getTrialBalance`'s own query (refactored to call it,
      output unchanged) so the Trial Balance and every Phase 5 report share
      one query instead of four near-duplicates — see
      `docs/accounting-engine.md` §8a. Structured so a future dimension
      filter (master spec §4; `journal_line_dimensions` already exists in
      the schema from Phase 1, unused by reporting yet — Slice 2) is one
      more clause here, not a rewrite.
- [x] **Profit & Loss** (`ReportingService.getProfitAndLoss`,
      `buildProfitAndLoss` in `src/domain/reporting/financial-statements.ts`):
      revenue/expense accounts for a selected date range, grouped with Total
      Revenue/Total Expenses/Net Profit subtotals, plus an optional
      comparison period (default: previous calendar month, also selectable
      as "same period last year" or none —
      `src/domain/reporting/period-presets.ts`) with a per-line variance
      column. Reflects only posted, non-draft, non-void journal lines.
- [x] **Balance Sheet** (`ReportingService.getBalanceSheet`,
      `buildBalanceSheet`): assets/liabilities/equity as of a selected date,
      with the fundamental accounting equation (Assets = Liabilities +
      Equity) explicitly verified and displayed — a green/red banner, not
      just cosmetic totals — plus an optional comparison as-of date. Since
      there is still no period-close process in this codebase, cumulative
      net profit is carried as two computed equity lines ("Retained
      Earnings (prior periods)" and "Current Year Earnings", split at the
      calendar year boundary) rather than a real closed Retained Earnings
      balance — the extended accounting equation this relies on, and why
      the split holds by construction, is written up in
      `docs/accounting-engine.md` §8b.
- [x] **Cash Flow Statement** (`ReportingService.getCashFlowStatement`,
      `buildCashFlowStatement`): indirect method, starting from the P&L's
      own Net Profit and adjusting for the period's change in every
      non-cash balance-sheet account, classified Operating/Investing/
      Financing (`classifyNonCashAccount`). Cash accounts are identified via
      `bank_accounts.glAccountId` (the same explicit link Phase 2's banking
      module already uses), never a free-text guess. Why the indirect
      method and not the direct method (this codebase has no
      transaction-level cash-vs-non-cash tagging), the classification rules,
      and the algebraic identity that guarantees the statement's own
      `reconciles` check always passes for a correctly posted ledger, are
      all written up in `docs/accounting-engine.md` §8c.
- [x] **Drill-down** (master spec §32: "Revenue → Account → Transaction →
      Invoice → Source Document"): every report line links to a new
      `/[orgSlug]/accounting/accounts/[accountId]/transactions` page
      (`ReportingService.getAccountTransactions`) listing that account's
      posted lines in range, each resolved to its source document (invoice/
      bill/supplier credit note/expense claim, by reverse `journalEntryId`
      lookup — `resolveSourceDocument`) with a link through to that
      document's existing detail page. The existing Trial Balance report
      and the Journal Entry detail page (which now also shows its own
      source-document link, via `getSourceDocumentForJournalEntry`) were
      both extended to link into this same drill-down page — see
      `docs/accounting-engine.md` §8d for the exact reverse-lookup tables
      and why `CUSTOMER_PAYMENT`/`SUPPLIER_PAYMENT` render as a label with
      no link (no dedicated payment detail page exists yet).
- [x] **CSV export** (`src/domain/reporting/csv-export.ts`, one export route
      handler per report under `.../export`): a plain, dependency-free CSV
      of exactly what the page shows, decimal strings never reformatted
      through a float. PDF/Excel export and the full report builder are
      explicitly Slice 2 (see below) — CSV was judged worth including as a
      low-effort baseline; the others are not.
- [x] New permission `financial_report:read`, gated **more narrowly** than
      Trial Balance's `journal:read` (OWNER/ADMINISTRATOR always; ACCOUNTANT/
      BOOKKEEPER/MANAGER/READ_ONLY explicitly granted; deliberately **not**
      granted to ACCOUNTS_PAYABLE/ACCOUNTS_RECEIVABLE/PAYROLL_MANAGER/
      EMPLOYEE) — a documented, deliberate divergence from Trial Balance's
      sensitivity level: the three new reports reveal whole-of-organization
      profitability and balance-sheet position, which is more sensitive than
      a subledger role's day-to-day AR/AP/payroll transaction access. The
      account-transactions drill-down page and the Journal Entry detail
      page's source-document link are gated on the existing, broader
      `journal:read` instead (see `docs/accounting-engine.md` §8d for why).
- [x] `AuditService` is **not** wired into this slice — every new service
      method is read-only (`assertPermission` then a `SELECT`-only
      `withTenant` block, never a write), so there is nothing to audit; this
      is intentional, not an oversight.
- [x] UI: `/[orgSlug]/accounting/reports/{profit-and-loss,balance-sheet,
      cash-flow}`, each with a date-range/comparison picker and an Export
      CSV button, added to the role-aware nav under "Accounting" alongside
      Trial Balance; the drill-down page at
      `/[orgSlug]/accounting/accounts/[accountId]/transactions`, reachable
      from every report line, Trial Balance, and (for its own account
      balances) nowhere else yet.
- [x] Tests: unit (`src/tests/unit/reporting/financial-statements.test.ts` —
      16 cases: P&L subtotals/comparison/variance with hand-computed
      numbers, Balance Sheet equation verification (balanced and
      deliberately unbalanced inputs), `classifyNonCashAccount` for every
      type/subtype combination, indirect-method cash flow reconciliation
      incl. a deliberately-broken reconciliation case; plus
      `period-presets.test.ts` — 6 cases incl. December→January rollback and
      a leap-year February; `csv-export.test.ts` — 2 cases incl. comma
      escaping), property-based
      (`src/tests/property/reporting/balance-sheet-invariant.property.test.ts`
      — for any sequence of random balanced postings across
      ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE accounts, posted through the
      real `PostingService` against a real Postgres instance, the resulting
      `ReportingService.getBalanceSheet` always balances exactly — the
      double-entry invariant already proven at the posting layer, proven
      again end-to-end through the reporting layer), integration
      (`src/tests/integration/reporting/financial-statements.test.ts` —
      posts a hand-computable mix of invoices, bills, and an expense claim
      across January/February 2026 through a single shared bank account,
      then verifies the P&L's Feb-vs-Jan revenue/expense/net-profit figures,
      the Balance Sheet's exact AR/AP/equity balances and its balanced
      check, and the Cash Flow Statement's reconciliation against the
      actual bank account balance move — all by hand-computed expectation,
      not just "a number came back"; plus a drill-down case confirming an
      account transaction resolves to its real source invoice), and a new
      tenant-isolation case (`src/tests/integration/tenant-isolation.test.ts`)
      confirming org B's reports and drill-down never include org A's
      posted activity or accounts
- [x] `npm run typecheck`, `npm run lint`, `npm test` (403 tests) and
      `npm run build` all pass; smoke-tested against a real local Postgres
      and a running production server (`next start`): registered a real
      user via `UserService`/`OrganizationService`, posted the same
      Jan/Feb invoice/bill/expense-claim mix as the integration test
      directly through the domain services (confirming the real dev
      database, not just the isolated test database, produces the same
      hand-verified figures: Feb Net Profit $6,390.00, Balance Sheet
      balanced at $30,690.00 both sides, Cash Flow net change -$3,960.00
      reconciling exactly to the bank account's actual balance move from
      $25,500.00 to $21,540.00), then logged in via the real NextAuth
      credentials flow (cookie-based session, not a bypass) and confirmed
      over HTTP: the Profit & Loss, Balance Sheet, and Cash Flow pages each
      return HTTP 200 with those exact figures rendered ("$6,390.00" net
      profit, "$30,690.00" balanced total, "($3,960.00)" net change, all
      literally present in the response HTML); the CSV export endpoint
      returns the same Feb-vs-Jan P&L numbers as CSV rows; the
      account-transactions drill-down page for the revenue account renders
      a link through to the real source invoice ("Invoice INV-000002"); and
      the Journal Entry detail page for that invoice's posting shows the
      same source-document link and the correct AR $8,800.00 debit /
      Revenue $8,000.00 credit / GST Payable $800.00 credit lines. A full
      browser click-through was not additionally performed in this
      environment, matching prior slices' documented smoke-test scope.
- **Deferred to Slice 2, explicitly, with reasons:**
  - **Dimensional reporting** (slicing any report by the `dimensions`/
    `dimension_values`/`journal_line_dimensions` tables Phase 1 already
    schema'd) — this slice's aggregation query is deliberately structured so
    adding a dimension filter is one more join/`and()` clause, not a
    rewrite, but actually exposing it as a UI filter is real, separate
    scope (which dimension, which values, how it composes with a
    comparison period) better done once the core statements exist to slice.
  - **Report builder** (a general "pick accounts/columns/filters and save a
    custom report" tool) — needs its own data model (saved report
    definitions) and UI, and is explicitly the next thing to build *on top
    of* this slice's reporting data model per the master spec's own
    phrasing, not alongside it.
  - **Natural-language reporting** (a structured-query path from a plain-
    English question to one of these reports/a report-builder query — never
    free-text LLM arithmetic on money, per docs/ai-agents.md's existing
    non-negotiables) — depends on the report builder's query representation
    existing first; there is nothing yet for an NL layer to translate into.
  - **Management report packs** (bundling multiple reports with commentary
    into one shareable document) — a packaging feature over reports that,
    before this slice, didn't exist yet to package.
  - **PDF/Excel export** — CSV was judged a reasonable low-effort baseline
    for this slice; a formatted PDF/Excel export is more UI/formatting work
    than this slice's scope justified, and fits naturally alongside the
    report builder in Slice 2.
  - **A configurable fiscal-year start** — the Balance Sheet's Retained
    Earnings/Current Year Earnings split currently assumes a calendar-year
    fiscal year (see `docs/accounting-engine.md` §8b); a true
    organization-level setting belongs with Phase 9's period-lock/close
    workflow, which is where fiscal-year semantics get defined properly.

## Phase 6 — AI (not started)

AI Financial Controller, specialist agents (Bookkeeping, AR, AP, Payroll,
Tax, FP&A), autonomy levels, command bar, daily/weekly finance briefs. See
`docs/ai-agents.md` for the architecture this phase implements against.

## Phase 7 — Operations (not started)

Projects/jobs, time tracking, inventory (incl. costing methods, landed
costs), fixed assets.

## Phase 8 — Payroll & Australia Compliance (not started)

Employee records, AU payroll engine (PAYG, super, STP), leave, BAS
workspace. Tax/payroll rules versioned and effective-date controlled per
master spec §24 — not implemented from memory; requires verified regulatory
source before implementation begins.

## Phase 9 — Advanced Finance (not started)

Budgets, forecasting, scenario modelling, multi-entity consolidation,
accountant practice management, workpapers, month-end close workspace,
period-lock override workflow.

## Phase 10 — Platform (not started)

Public API, webhooks, integration marketplace, advanced automation centre.

## Explicit non-goals for this session

Everything not in Phase 1 above. Building shallow stubs across all 10 phases
would violate master spec §82 ("do NOT attempt to implement 80 superficial
features simultaneously... build vertical slices") and §85 (a feature isn't
done until it has correct domain behavior, permissions, audit, tests). Phase
1 is built to that bar; later phases are sequenced, not started.
