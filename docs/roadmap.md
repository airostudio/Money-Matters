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
- [x] Period-lock override workflow UI — reject path enforced in Phase 1; the
      override and reopen workflow (lock levels, audited soft-lock override,
      reopen with reason, append-only history) was built in Phase 9 Slice 3

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
- **Deferred to Slice 2** (dimensional reporting, report builder,
  natural-language reporting, management report packs, PDF/Excel export,
  configurable fiscal-year start) — see Slice 2 below for what was actually
  built against each of these and what's carried forward again to Slice 3.

### Slice 2 — Dimensional reporting, report builder, natural-language reporting — **complete**; management report packs — **complete (on-demand only)**; PDF/Excel export and fiscal-year config — **deferred to Slice 3**

- [x] **Dimensional reporting** (master spec §4's "Universal Dimension
      Engine"). `dimensions`/`dimension_values`/`journal_line_dimensions`
      have existed in the schema since Phase 1, and `PostingService` could
      already accept `dimensionValueIds` per line, but **nothing in the app
      could create a `Dimension`/`DimensionValue` at all**, and no posting
      path ever passed `dimensionValueIds` — verified by grepping the whole
      codebase before writing anything, not assumed from the Slice 1 notes.
      This slice closes that gap honestly rather than faking it:
      - `src/domain/dimensions/dimension-service.ts` — CRUD for dimensions
        and their values, gated on the already-existing-but-previously-unused
        `dimension:manage` permission (split from a new, more broadly
        granted `dimension:read` so anyone with `financial_report:read` can
        filter a report by dimension without being able to create one).
        `/[orgSlug]/accounting/dimensions` is the admin UI.
      - **Tagging entry point**: the manual Journal Entry form
        (`/[orgSlug]/accounting/journals/new`) — chosen deliberately as the
        smallest, cleanest addition, since `PostingService` already accepted
        `dimensionValueIds` end to end for this path. `JournalLineEditor`
        gained an optional per-line dimension picker (one dimension value
        per line, not one per configured dimension — documented in its own
        doc comment as a limitation, not a bug).
      - **Explicitly NOT done this slice**: attaching a dimension to an
        individual invoice or bill line item. That touches Phase 3/4's
        `InvoiceService`/`BillService` line editors and their multi-line
        forms across several pages — real, separate scope, not a quick
        addition the way the single-entry journal form was. Deferred to
        Slice 3, documented in the Dimensions page's own copy so the gap is
        visible to users, not just in this file.
      - `gl-aggregation.ts`'s `sumPostedActivityByAccount` gained the
        `dimensionValueId` filter Slice 1's own doc comment anticipated (one
        join against `journal_line_dimensions`, short-circuited to an
        all-zero result when nothing is tagged with that value — never an
        unfiltered fallback that would silently show the wrong numbers).
        `ReportingService.getProfitAndLoss`/`getBalanceSheet` both take an
        optional `dimensionValueId` now, with a `DimensionFilterField`
        dropdown added to both report pages (and their CSV export routes).
- [x] **Report builder** (master spec §33) —
      `src/domain/reporting/report-builder-service.ts` /
      `/[orgSlug]/accounting/reports/builder`. A generalized, configurable
      version of Slice 1's P&L/Balance Sheet grid: rows (individual accounts
      or account-type totals), columns (a single period, or a monthly/
      quarterly breakdown — `period-presets.ts` gained `monthlyColumns`/
      `quarterlyColumns`/`lastNMonths`/`lastNQuarters`/quarter-range
      helpers), a measure (`BALANCE` = cumulative as-of the column's end
      date, `MOVEMENT` = activity within the column's own range), filters
      (date range, account type, dimension), and an optional comparison
      period (the prior equivalent range). Every number still comes from
      `sumPostedActivityByAccount` — this module adds no new aggregation
      query, only configuration over the existing one.
      `ReportBuilderConfigSchema` (zod) is the single validated shape both a
      human-built form submission and an AI-translated NL request must
      produce — see below.
      Saved as `saved_reports` (org-scoped, `PERSONAL`/`ORGANIZATION`
      visibility, `config` stored as JSON): **a saved query, never a cached
      result** — reloading and re-running a saved report always re-executes
      `config` against current data, proven by an integration test that
      posts a new transaction between two runs of the same saved report and
      confirms the second run picks it up. New `saved_report:manage`
      permission for saving/deleting (reusing `financial_report:read` for
      running/viewing one).
- [x] **Natural-language reporting** (master spec §34, quoted in full in
      `docs/ai-agents.md` §0b) — `src/domain/reporting/nl-report-query.ts`
      (schema + deterministic resolution) and
      `src/domain/reporting/nl-reporting-service.ts` (the AI call),
      `/[orgSlug]/accounting/reports/ask`. Follows the exact
      interpret → structured request → deterministic resolution →
      deterministic execution → render pipeline master spec §34 specifies,
      reusing the report builder's own engine for the last two steps —
      see `docs/ai-agents.md` §0b for the full writeup, including the one
      documented place this diverges from every prior AI integration here:
      there is no deterministic fallback that *answers the question* when
      the AI is unavailable (a wrong guess at what was asked is worse than
      no answer), so a missing `ANTHROPIC_API_KEY`/failed call/schema
      validation failure all resolve to "natural-language queries aren't
      available right now, try the Report Builder" rather than any report
      at all.
- [x] **Management report packs** (master spec §33) —
      `src/domain/reporting/management-pack-service.ts`,
      `/[orgSlug]/accounting/reports/management-pack`: P&L + Balance Sheet +
      Cash Flow summarized together with a short AI-written commentary
      paragraph, generated **on demand only** — master spec §33 also
      describes a *scheduled* pack, but no job-queue infrastructure exists
      in this codebase (Phase 2 Slice 2's deferral, carried forward every
      slice since), so only the on-demand version was built. The commentary
      step reuses the "AI never produces a financial figure" principle one
      more time (see `docs/ai-agents.md` §0b) but is the one place in this
      codebase where that can't be enforced with a schema, since the output
      is prose, not a structured value — handled by labeling the commentary
      as AI-generated and always showing the real figures independently
      alongside it, never in place of them.
- [x] New permissions: `dimension:read` (split out of the existing
      `dimension:manage` so report-filtering access doesn't require
      dimension-admin access), `saved_report:manage`. Every mutation
      (creating/deactivating a dimension or value, saving/deleting a saved
      report) goes through `AuditService.record` in the same transaction.
- [x] Tests: unit (`period-presets.test.ts` extended with 15 new cases for
      the monthly/quarterly/last-N-periods helpers;
      `report-builder-config.test.ts` — 9 cases validating
      `ReportBuilderConfigSchema` rejects every malformed/out-of-range shape;
      `nl-report-query.test.ts` — 18 cases: schema rejection of a
      hallucinated metric/period/breakdown, and `resolveNLReportRequest`'s
      deterministic resolution for every metric/period combination,
      including rejecting — never guessing — a dimension reference that
      doesn't match a real one), integration
      (`report-builder.test.ts` — 7 cases: hand-computed MOVEMENT/BALANCE/
      monthly-breakdown figures against real posted data, the
      save-then-re-run-after-a-new-posting non-caching proof, PERSONAL vs.
      ORGANIZATION visibility across two real users, and dimension filtering
      matching `ReportingService`'s own filter; `nl-reporting.test.ts` — 6
      cases: a full round trip with a mocked Anthropic tool-use response
      whose resulting figures are asserted equal to the equivalent
      manually-built report-builder query, a real dimension reference
      resolved end to end, and three distinct unavailable-but-never-wrong
      paths (network failure, schema-invalid response, no API key);
      `dimension-service.test.ts` — 7 cases covering CRUD, duplicate-key/
      value rejection, active/inactive filtering, and the
      `dimension:manage`-vs-`dimension:read` permission split) and a new
      tenant-isolation case for `saved_reports` (invisible cross-tenant,
      and `runSavedReport`/`deleteSavedReport` both reject as the wrong org).
- [x] `npm run typecheck`, `npm run lint`, `npm test` (460 tests, up from
      403) and `npm run build` all pass; smoke-tested against a real local
      Postgres: a script-driven run (domain services directly, mirroring
      `scripts/seed.ts`'s own approach) created a real org, tagged a journal
      line with a dimension, confirmed `ReportingService.getProfitAndLoss`'s
      dimension filter produced the correct subset ($1,000 of $1,500 total
      revenue), saved a report builder config, confirmed its first run's
      total, posted a new transaction, and confirmed the saved report's
      second run picked up the new figure (proving it is not a cached
      snapshot) — then logged in via the real NextAuth credentials flow
      (cookie-based session) and confirmed over HTTP that
      `/accounting/reports/{profit-and-loss,balance-sheet,builder,ask,
      management-pack,dimensions}` and `/accounting/journals/new` (with its
      new dimension picker) all return HTTP 200, with the Report Builder
      page's rendered HTML containing the real "$1,000.00" revenue figure
      for a dimension-less query against the same seeded data. The
      natural-language reporting pipeline's AI call itself was exercised
      only with a mocked SDK response (no `ANTHROPIC_API_KEY` was available
      in this environment) — its clarification/unavailable/schema-rejection
      paths are covered by the integration tests above, but a live call to
      the real Anthropic API was not performed in this environment, matching
      the same documented limitation every prior AI integration in this
      codebase has noted.
- **Deferred to Slice 3, explicitly, with reasons:**
  - **Invoice/bill line-level dimension tagging** — see the dimensional
    reporting notes above; real, separate scope across Phase 3/4's line
    editors, not attempted here to keep this slice's dimension work to a
    clean, honest, fully-wired vertical slice (admin → tagging → reporting)
    rather than a half-wired one spread thinner across more entry points.
  - **PDF/Excel export** — CSV (Slice 1) and the Report Builder's on-screen
    table (this slice) cover the practical "get the numbers out" need; a
    properly formatted PDF or Excel export is real, additional rendering
    work (a server-side HTML-to-PDF step and a spreadsheet-writing
    dependency, neither of which exists in this codebase yet) that didn't
    fit cleanly alongside the two higher-priority features this slice was
    asked to prioritize. Still worth doing, just not at the cost of rushing
    the report builder or NL reporting.
  - **A configurable fiscal-year start** — unchanged from Slice 1's own
    deferral note: the Balance Sheet's Retained Earnings/Current Year
    Earnings split (`docs/accounting-engine.md` §8b) still assumes a
    calendar-year fiscal year (Jan 1 – Dec 31) for the prior-periods/
    current-year-earnings boundary, and the report builder's own BALANCE
    measure inherits the same assumption. A true per-organization setting
    is a real, somewhat invasive schema + retained-earnings-logic change
    that belongs with Phase 9's period-lock/close workflow, where
    fiscal-year semantics get defined properly rather than bolted on here.

## Phase 6 — AI

### Slice 1 — AI Financial Controller foundation + Daily Finance Brief (complete)

- [x] **AI Financial Controller** (`src/domain/ai-controller/`): a
      persistent conversational assistant (`/[orgSlug]/ai-finance`,
      replacing the earlier scaffold placeholder) built exactly to master
      spec §50's "Intent → Permission → Validation → Tool → Result → Audit"
      pipeline and §49's non-negotiable permission discipline. A **fixed,
      explicit set of nine read-only tools**
      (`src/domain/ai-controller/controller-tools.ts`) — `trial_balance`,
      `profit_and_loss`, `balance_sheet`, `aged_receivables` (with Phase 3
      Slice 2's collection priority score), `aged_payables`, `find_invoice`,
      `find_bill`, `find_expense_claim`, and `run_report` (reusing Phase 5
      Slice 2's `resolveNLReportRequest` + `ReportBuilderService.runConfig`
      verbatim rather than a parallel query path) — each a thin wrapper
      around an already-existing domain-service method, called via Claude's
      tool-use feature in a capped (5-round) loop
      (`src/domain/ai-controller/financial-controller-service.ts`). No tool
      writes, posts, or modifies anything.
    - **The permission check is never duplicated or widened**: every tool
      wrapper passes the real, authenticated actor straight into the same
      domain-service call a route handler would make, so `assertPermission`
      runs exactly once, in exactly the place it already ran. A refusal
      (`PermissionDeniedError`) is caught and turned into a plain-language
      refusal the model is instructed to relay honestly — proven, not just
      asserted, by `src/tests/integration/ai-controller/financial-controller.test.ts`
      (a real `EMPLOYEE`/`PAYROLL_MANAGER` actor against the real database,
      `financial_report:read`-gated questions refused end to end with zero
      citations recorded) and smoke-tested over real HTTP (a restricted
      role's authenticated session gets the same refusal the equivalent
      report page gives). Building this found and fixed one real bug before
      it shipped: the loop unconditionally called `DimensionService.listActive`
      to build `run_report`'s dimension hint, which itself requires
      `dimension:read` — a role without it (`EMPLOYEE`, `PAYROLL_MANAGER`)
      got an uncaught `PermissionDeniedError` crashing the *entire*
      conversation turn rather than a narrower refusal. Fixed by falling
      back to an empty dimension list for that actor, never by widening the
      permission check.
    - Every final answer is built from the tool results actually returned
      — the model narrates and cites, it never computes or recalls a figure
      itself. A runtime guard (`looksLikeUncitedFigure`, deliberately narrow
      — see its doc comment) refuses a final answer that contains a
      currency-shaped figure when no tool was ever called that turn, so a
      prompt-following failure degrades to "I can't answer that from
      memory" rather than shipping a hallucinated number. A deterministic
      "Sources" footer (tool + period + drill-down link) is appended by the
      application, never left to the model to self-report.
    - Missing `ANTHROPIC_API_KEY` or a failed/timed-out call resolves to
      "the AI Financial Controller isn't available right now" — the same
      no-fallback-that-answers-the-question discipline as NL reporting
      (docs/ai-agents.md §0b), for the same reason: there's no safe
      deterministic guess at what a free-text question meant.
    - Audit: every conversation turn that made at least one tool call is
      recorded via `AuditService` with `actorType: "AI"` (the onboarding
      wizard's established convention), listing which tools were called and
      by whom — a chitchat turn with no tool call logs nothing. Best-effort
      (wrapped so an audit-write failure never blocks the user's
      already-computed answer — this is a read-only path, unlike a mutation
      whose audit record must share its transaction).
- [x] **Daily Finance Brief** (master spec §73,
      `src/domain/reporting/daily-finance-brief-service.ts`,
      `/[orgSlug]/ai-finance/brief`, plus a condensed widget on the org home
      page): cash position (every linked bank account's real GL balance, via
      `LedgerService.getTrialBalance` — never the `bank_accounts.currentBalance`
      cache), money in/out expected in the next 7 days and overdue
      receivables/payables (from `AgedReceivablesService`/`AgedPayablesService`,
      which already compute every unpaid invoice/bill's days-until/-past
      due), and payment runs awaiting approval (`PaymentRunService.list`
      filtered to `AWAITING_APPROVAL`) — no new aggregation logic anywhere,
      every figure reuses an existing domain-service call and every number
      drills down into the real report/record page. An **optional** short
      AI-written summary paragraph sits on top, following the Management
      Report Pack's established pattern exactly: handed only the
      already-computed figures, never a source of a new one, clearly
      labeled, omitted (not faked) without an API key.
- [x] **What's deferred to Slice 2, and why**: the specialist-agent system
      (Bookkeeping/AR/AP/Payroll/Tax/FP&A agents sitting behind the
      Controller), the autonomy-level framework (master spec §8's Level
      0-4), and a free-text command bar that drafts or posts transactions —
      all three are real, separate features that need this slice's
      tool-calling foundation (the fixed-tool-registry + permission-checked
      execution loop) to exist first; building them simultaneously would
      have meant extending an unproven pattern in three directions at once.
      A **scheduled/emailed** version of the Daily Finance Brief is also
      deferred — no job-queue/scheduler infrastructure exists in this
      codebase (the same gap documented since Phase 2 Slice 2 and carried
      forward through the Management Report Pack); only the on-demand
      version is built, never a fake "scheduled" toggle with nothing behind
      it.
- [x] Tests: unit (`src/tests/unit/ai-controller/financial-controller-loop.test.ts`
      — the tool-call-loop orchestration against a mocked Anthropic client,
      no database: the round cap, malformed tool-call-argument rejection,
      and the uncited-figure guard), integration
      (`src/tests/integration/ai-controller/controller-tools.test.ts` — each
      tool wrapper's delegation and permission refusal against the real
      database; `src/tests/integration/ai-controller/financial-controller.test.ts`
      — the full mocked-tool-use round trip matching `ReportingService`'s
      own real output exactly, plus the explicit restricted-role permission-
      refusal proof described above; `src/tests/integration/reporting/daily-finance-brief.test.ts`
      — every brief figure checked against seeded data and a direct query
      of the same underlying services)
- [x] `npm run typecheck`, `npm run lint`, `npm test` (487 tests) and
      `npm run build` all pass; smoke-tested over real HTTP against a real
      local Postgres and a running production server (`next start`):
      register → sign in → the Daily Finance Brief page renders real seeded
      figures (an overdue invoice's exact $2,500.00 total) matching a direct
      SQL query → a restricted `EMPLOYEE` session gets the same refusal the
      equivalent report page gives for the Brief and the org home page,
      while the Controller's chat page itself (self-gating per tool call,
      by design) still renders for them. The Controller's own tool-calling
      turn (the server action invoking the mocked-Anthropic-client loop) was
      exercised via the real-database integration tests above, not over raw
      HTTP — Next.js Server Actions invoked imperatively (not via a plain
      `<form>`) use a binary RSC wire protocol with no documented
      curl-reproducible format, the one piece of this slice's HTTP smoke
      testing that stayed at the integration-test level. The actual
      Anthropic API call itself is, as with every other AI feature in this
      codebase, only ever exercised via a mocked SDK — never a real network
      call in tests or CI.

### Slice 2 — autonomy levels, prepare-only write tools, specialist agents (complete)

- [x] **Autonomy setting** (master spec §8, `organizations.ai_autonomy_level`,
      `src/domain/ai-controller/autonomy.ts`): Levels 0 (Manual) and 1
      (Suggest) are both "information only" — every organization's default,
      and identical in behavior to all of Slice 1. Level 2 (Prepare)
      additionally offers three write-capable tools (below) and is an
      explicit OWNER/ADMINISTRATOR-only opt-in on the Settings page —
      `AutonomySettingsService.setLevel` enforces `organization:manage`.
      Levels 3 (Auto, low-risk) and 4 (Finance automation) are **not
      implemented** — `setLevel` actively rejects them rather than silently
      accepting a value nothing honors. Reason: master spec §8 itself names
      "large payments, bank-detail changes, payroll changes, tax
      submissions, unusual journals, period closes" as always requiring
      authorisation, and every mutating action this codebase has today
      (invoicing, billing, journal posting, payment runs) is exactly that
      kind of action — auto-executing any of it needs a trust/audit track
      record this codebase doesn't have yet. The gate is enforced on
      *tool-list construction*: `FinancialControllerService.ask` only calls
      `buildWriteTools()` at Level 2+, so a Level 0/1 organization's
      conversation never has a `prepare_draft_*` tool in its `tools` array
      at all, proven in `src/tests/unit/ai-controller/autonomy-gating.test.ts`
      by inspecting the actual payload sent to the (mocked) Anthropic call.
- [x] **Three write-capable, prepare-only Controller tools**
      (`src/domain/ai-controller/write-tools.ts`): `prepare_draft_invoice`
      (wraps `InvoiceService.create`), `prepare_draft_bill` (wraps
      `BillService.create`), `prepare_draft_journal_entry` (wraps
      `PostingService.createDraft`) — the exact same DRAFT-only methods a
      human using the Sales/Purchases/Journal UI calls directly; no new
      ledger-writing code path was invented. Each tool resolves the model's
      free-text request (a customer/supplier name, an account name) against
      real organization records — never trusting an id or name the model
      merely claims, exactly like Phase 2 Slice 2's fuzzy-reconciliation
      candidate matching and Phase 5 Slice 2's dimension matching — and an
      unmatched or ambiguous reference is a hard failure asking for
      clarification, never a guess.
- [x] **The proposal/confirmation split is the slice's structural
      guarantee, not a UI nicety**: a successful tool call creates a
      PENDING row in a new `ai_draft_proposals` table
      (`src/domain/ai-controller/draft-proposal-service.ts`) — a resolved,
      fully-validated creation payload plus a human-readable preview — and
      **nothing else**. Only `AIDraftProposalService.confirm`, triggered by
      a separate, explicit "Create this draft?" click in the chat UI (a
      different server action from the one that ran the conversation turn),
      ever calls the real `InvoiceService.create`/`BillService.create`/
      `PostingService.createDraft`, under the real authenticated confirming
      actor, re-running the real permission check for real. A tool call
      alone is proven, in a real-database integration test, to create zero
      invoice/bill/journal-entry rows
      (`src/tests/integration/ai-controller/write-tools.test.ts`), and the
      full conversation → proposal → separate confirmation → real DRAFT
      round trip is proven end-to-end in
      `src/tests/integration/ai-controller/draft-proposal-flow.test.ts`.
- [x] **Audit**: proposing is audited as `actorType: "AI"`
      (`ai_controller.draft_proposed`); confirming is audited separately as
      `actorType: "HUMAN"` (`ai_controller.draft_confirmed`, metadata naming
      both the original proposer and the confirming user) — on top of the
      creation itself already being audited as `HUMAN` by
      `InvoiceService.create` etc. Both halves are recorded per master spec
      §44's "for AI actions also store: agent, model, ..., proposed action,
      approver, outcome," neither hiding the other.
- [x] **Specialist agents as scoped modes, not a new framework**
      (`src/domain/ai-controller/specialist-agents.ts`): Bookkeeping, AR,
      AP, and FP&A are each a fixed tool-subset + system-prompt addendum
      over the one Controller loop (`FinancialControllerService.ask`'s new
      `agentMode` parameter) — never a second orchestration framework, never
      bespoke data access. AR gets `prepare_draft_invoice` at Level 2, AP
      gets `prepare_draft_bill`, Bookkeeping gets `prepare_draft_journal_entry`
      (no bank-posting write tool exists this slice, so Bookkeeping is
      otherwise read-only), and FP&A is read-only by design (profitability/
      trend/KPI analysis over existing reports — explicitly told to say
      budgeting isn't built yet rather than invent a budget figure, since no
      budgeting feature exists anywhere in this codebase).
- [x] **Payroll and Tax & Compliance specialist agents are deliberately NOT
      built**, not even as empty-toolset modes. Reason: there is no payroll
      domain (employee records, pay runs, PAYG/super) and no tax-filing/BAS
      domain in this codebase yet (Phase 8 hasn't started) — an agent "for"
      either would have no real tool behind it, which is exactly the
      shallow-stub this codebase's roadmap (§82/§85) refuses to ship.
      `DEFERRED_AGENTS` names both with this reason so the chat UI shows
      them as visibly disabled rather than silently absent.
- [x] **Weekly Finance Brief — deferred, with a reason.** The task invited
      widening Slice 1's `DailyFinanceBriefService` to a weekly rollup "only
      if it's a clean, small addition." A genuinely useful weekly brief
      means summarizing the *past* week's activity (invoices/bills raised,
      cash movement, a week-over-week delta) — new aggregation and
      comparison logic, not a parameter rename. Simply widening the
      existing "next 7 days" forward-looking window and relabeling it
      "weekly" would produce numbers close to identical to the daily brief
      while implying a different kind of report exists — exactly the
      shallow restyling this codebase's roadmap refuses to ship. Deferred
      to whenever period-over-period trend reporting is built properly
      (Phase 9's forecasting work is the natural home), not attempted here.
- [x] Tests: unit
      (`src/tests/unit/ai-controller/autonomy-gating.test.ts` — the
      autonomy-level tool-offering gate at Levels 0/1/2 and per agent mode,
      against a mocked Anthropic client, no database), integration
      (`src/tests/integration/ai-controller/write-tools.test.ts` — every
      write tool's name/account resolution, permission refusal, and
      balance validation against the real database, plus
      `AutonomySettingsService`'s own permission/validation behavior and
      `AIDraftProposalService.confirm`'s full real-DB proof: a real DRAFT
      invoice/bill/journal entry created only via the real underlying
      service, audited with both AI-proposal and human-confirmer details,
      a lowered autonomy level blocking a stale confirmation, and a
      restricted-role confirmer refused at the real creation step even
      though the PENDING proposal itself was visible to them;
      `src/tests/integration/ai-controller/draft-proposal-flow.test.ts` —
      the full mocked-tool-use conversation → proposal → separate
      confirmation round trip, a Level 0 org never offering the write tool
      for the identical request, and an EMPLOYEE actor's tool call being
      refused inside the tool itself even when the org is at Level 2).
- [x] `npm run typecheck`, `npm run lint`, `npm test` (516 tests — the 487
      from Slice 1 plus 29 new) and `npm run build` all pass against a local
      Postgres (two new migrations: an `ai_autonomy_level` column on
      `organizations`, and the `ai_draft_proposals` table with the same
      FORCEd-RLS tenant-isolation policy every other tenant table has —
      confirmed by `db:migrate`'s own tenant-isolation audit going from
      45/49 to 46/50 org-scoped tables). The full proposal → confirmation →
      real DRAFT-invoice → audit-trail round trip, the autonomy-level gate,
      and every permission refusal (including the "shown a proposal but not
      permitted to confirm it" case) are verified for real against the test
      database by the integration tests above — not mocked. The real
      Anthropic API call itself is, as with every other AI feature in this
      codebase, only ever exercised via a mocked SDK — never a real network
      call in tests or CI. A logged-in browser/curl walkthrough of the chat
      UI's "Create this draft?" confirmation click was not re-driven this
      slice for the same reason Slice 1's own smoke test stopped at the
      integration-test level for its server action: a Next.js Server Action
      invoked imperatively (not via a plain `<form>`) uses a binary RSC wire
      protocol with no documented curl-reproducible format. `next build`
      and `next start` were run against a real local Postgres (auth-gated
      page redirects confirmed over real HTTP) in addition to the
      real-database integration-test proof above.

### Slice 3 — the real 0-4 autonomy slider: whitelisted auto-execution (complete)

User-authorized expansion beyond Slice 2's scope ("Let's have levels of
autonomy, the user can select how much on a sliding scale, that makes it the
user's responsibility" — "it will be most things, just not critical things
as mentioned"). This slice builds the real five-level dial master spec §8
describes, where Levels 3-4 let the AI auto-EXECUTE (not just prepare-and-
wait) a narrow, pre-approved set of actions — while the critical-action
carve-out from §8 stays human-gated at every level, no exception, exactly as
the user confirmed.

- [x] **`AutonomySettingsService.setLevel` now accepts 0-4** (`autonomy.ts`)
      — the `InvalidAutonomyLevelError` rejection of 3/4 from Slice 2 is
      gone; only a genuinely out-of-range value (5, -1, ...) is rejected
      now. `AUTONOMY_LEVEL_LABELS`/`AUTONOMY_LEVEL_DESCRIPTIONS` give a
      plain-English explanation per level for the Settings UI ("don't make
      the user guess" what a level does).
- [x] **The whitelist mechanism (master spec §76: "learn ... only through
      controlled configuration")** — a new `ai_auto_approved_actions` table
      (`organizationId`, `actionType`, unique per pair) is the per-org,
      per-action-type opt-in list `src/domain/ai-controller/
      auto-execution-policy.ts` reads. Selecting Level 3 or 4 inserts
      **zero** rows here by itself — `isAutoExecutionApproved(organizationId,
      actionType)` requires BOTH `level >= 3` AND an explicit whitelist row,
      read fresh from Postgres on every single check, never cached. This is
      proven in `src/tests/integration/ai-controller/auto-execution.test.ts`:
      a Level 4 org with an empty whitelist auto-executes nothing despite
      due work existing, and a whitelisted action type at Level 2 still
      doesn't execute (level checked independently of the whitelist).
- [x] **The closed allowlist**: `AUTO_APPROVABLE_ACTION_TYPES` has exactly
      three members —
      `RECURRING_INVOICE_AUTO_GENERATE`/`RECURRING_BILL_AUTO_GENERATE`
      (auto-triggers the existing, already-human-triggered
      `RecurringInvoiceService.generateDue`/`RecurringBillService.generateDue`
      — "trigger the thing a human would have clicked," never new business
      logic) and `BANK_RECONCILIATION_AUTO_MATCH` (auto-confirms ONLY a
      deterministic, same-day, exact-amount `ReconciliationService.
      findCandidateMatches` candidate — confidence exactly 1.0 — via the
      exact same `confirmMatch` a human's "Confirm match" click already
      calls). **Deliberately never auto-confirms an AI-scored
      `FuzzyReconciliationService` suggestion, however high its reported
      confidence** — a probabilistic judgment is not the "previously
      human-approved category" §76 describes, so fuzzy suggestions stay
      propose-only at every autonomy level, with no exception for Level 4.
      Both the Postgres enum column and a zod schema in application code
      enforce this closed set — `AutoApprovedActionsService.setEnabled`
      refuses an excluded value (`SUPPLIER_PAYMENT_CREATE`,
      `BANK_ACCOUNT_DETAIL_CHANGE`, `PAYROLL_ANY`, `TAX_SUBMISSION_ANY`,
      `JOURNAL_ENTRY_UNUSUAL`, `FISCAL_PERIOD_CLOSE`, ...) with
      `InvalidAutoApprovedActionTypeError`, structurally, at Level 4 exactly
      as it would be refused at Level 0 — proven in both
      `src/tests/unit/ai-controller/auto-execution-policy.test.ts`
      (allowlist/exclusion-list disjointness, no database) and the
      integration suite (an actual attempt to whitelist one, refused).
      `prepare_draft_journal_entry` (Slice 2) is never promoted to
      auto-execute at any level — there is no `JOURNAL_ENTRY` entry in the
      allowlist at all, so an "unusual" freeform journal entry stays
      confirmation-gated structurally, not by convention.
- [x] **`PaymentRunService`'s segregation-of-duties check is untouched and
      remains the sole authority over payment approval** — no autonomy
      level logic was added in front of or instead of it; nothing in
      `AutoExecutionService` calls `PaymentRunService` at all. Proven with a
      real-database test: a Level 4 org with every action type whitelisted
      still gets `SelfApprovalNotAllowedError` when the same user who
      created a payment run tries to approve it, exactly as at Level 0.
- [x] **Honest Level 3 vs. Level 4 distinction: there isn't a safely-
      buildable one with what exists in this codebase today, and this is
      stated plainly rather than fabricated.** Both levels share the
      identical whitelist mechanism and, right now, the identical closed
      set of three auto-approvable action types — exactly the same honest
      choice Slice 2 made for Levels 0/1 ("functionally identical today,
      kept as distinct values because master spec §8 names them
      distinctly"). The task suggested one candidate Level-4-only
      distinction (auto-promoting an auto-drafted invoice/bill into a
      "ready for review" queue) — this was deliberately NOT built: there is
      no "ready for review" status anywhere in `invoice_status`/
      `bill_status` today, and inventing one purely to manufacture a 3-vs-4
      difference would be exactly the shallow, fabricated distinction the
      task asked not to produce. A real Level-4-only action type becomes
      possible once this codebase has a second low-risk, reversible,
      already-human-triggered mechanism to reserve for it — e.g. once a
      bank-feed auto-import/categorization pass or a second reconciliation
      strategy exists.
- [x] **Human override machinery (master spec §77)**:
    - **Visibly flagged, not buried in the audit log**: a new
      `ai_auto_executions` table records every auto-executed action
      (actionType, entityType/entityId, confidence, autonomy level,
      who triggered the check). The invoice and bill list pages
      (`sales/invoices`, `purchases/bills`) query it to render a distinct
      "AI auto" badge next to an auto-created draft; the Daily Finance
      Brief surfaces a callout when any auto-execution happened in the last
      24 hours.
    - **Trivially undoable, never a destructive edit**:
      `AutoExecutionService.undo` calls `InvoiceService.deleteDraft`/
      `BillService.deleteDraft` for an auto-generated draft (still a plain
      DRAFT — nothing was posted), and a new `ReconciliationService.unmatch`
      for an auto-confirmed bank match (reverts the link; refuses if the
      transaction was instead reconciled by posting a brand-new journal
      entry, since undoing that must go through `PostingService.
      reverseEntry`, never a status flip — but auto-execution in this slice
      never takes that path in the first place, only the link-to-existing-
      line path).
    - **A real, reachable emergency stop, separate from the normal settings
      form**: `AutonomySettingsService.emergencyStop` drops the org straight
      to Level 0 and leaves the whitelist untouched (so re-enabling later
      restores the same configuration). There is no cache to invalidate —
      `isAutoExecutionApproved` reads the level fresh from Postgres on every
      call — so the very next check anywhere in the app is blocked
      immediately. Proven with a real-database test: Level 4 + a
      whitelisted action type auto-executes once, emergency stop is
      triggered, new due work is created, and the very next
      `runPendingAutoExecutions` call executes nothing, with the whitelist
      row still present in the database.
- [x] **Who triggers it, given no job-queue infrastructure exists**
      (the same documented gap since Phase 2 Slice 2): a conversation turn
      with the AI Financial Controller (`FinancialControllerService.ask`)
      runs `AutoExecutionService.runPendingAutoExecutions` as a best-effort
      first step (never blocking the user's actual question on failure),
      and the Settings page has its own "Run automated actions now" button
      — the same honest "on-demand precursor to real scheduling" framing
      `RecurringInvoiceService.generateDue` itself already carried forward
      from Phase 3 Slice 2.
- [x] **Settings UI**: the autonomy picker now spans 0-4 with a plain-
      English description per level; at Level 3/4 a whitelist panel appears
      with one checkbox-equivalent toggle per auto-approvable action type
      (unchecked by default, even at Level 4); a "Run automated actions
      now" button; and a visually distinct, separately-labeled "Emergency
      stop" control that drops straight to Level 0.
- [x] Tests: unit
      (`src/tests/unit/ai-controller/auto-execution-policy.test.ts` — the
      allowlist is small/specific (not "everything except excluded"),
      disjoint from a documented excluded-category example list, and
      `isAutoApprovableActionType`/`InvalidAutoApprovedActionTypeError`
      refuse every excluded example, no database), integration
      (`src/tests/integration/ai-controller/auto-execution.test.ts` — level-
      alone-does-nothing at Level 4 with empty whitelist and at Level 2 with
      a whitelist entry; excluded-category whitelisting refused at Level 4;
      `PaymentRunService` self-approval still blocked at Level 4 with a full
      whitelist; `prepare_draft_journal_entry` never auto-promoted; full
      whitelisted end-to-end round trips for both recurring-invoice and
      recurring-bill auto-generation and for bank-reconciliation auto-match,
      each checked for the "AI auto" flag, the master-spec-§44 audit fields
      including the honest "auto-approved under org policy" approver, and
      successful `undo`; the emergency stop's immediate, no-caching effect
      with new due work appearing after the stop).
- [x] `npm run typecheck`, `npm run lint`, `npm test` (533 tests — the 516
      from Slice 2 plus 17 new) and `npm run build` all pass against a local
      Postgres (two new migrations: `ai_auto_approved_actions` and
      `ai_auto_executions`, both with the same FORCEd-RLS tenant-isolation
      policy every other tenant table has — confirmed by `db:migrate`'s own
      tenant-isolation audit going from 46/50 to 48/52 org-scoped tables).
      Smoke-tested for real against a local Postgres (a throwaway script
      exercising the real domain services, not mocks, deleted afterward):
      Level 4 with an empty whitelist auto-executed nothing; whitelisting
      `RECURRING_INVOICE_AUTO_GENERATE` then re-running auto-executed
      exactly one due invoice, visibly flagged as AI-auto in the lookup the
      invoice list page uses; attempting to whitelist
      `SUPPLIER_PAYMENT_CREATE` was refused with
      `InvalidAutoApprovedActionTypeError`; triggering the emergency stop
      and creating new due work afterward produced zero further
      auto-execution on the next check. The real Anthropic API call itself
      is, as with every other AI feature in this codebase, only ever
      exercised via a mocked SDK in the Controller's own loop tests — never
      a real network call in tests or CI; none of this slice's own
      mechanism (the whitelist gate, the three runners, undo, emergency
      stop) involves an LLM call at all, so there was nothing to mock there
      in the first place.

## Phase 7 — Operations — **complete**

### Slice 1 — Projects/Jobs & Time Tracking (complete)

- [x] **Schema** (`src/db/schema.ts`): `projects` (org-scoped: optional
      customer, unique-per-org `code`, name, status enum
      ACTIVE/ON_HOLD/COMPLETED/CANCELLED, `budgetedRevenue`/`budgetedCost`,
      a simple `defaultHourlyRate`, start/end dates) and `project_tasks`
      (a deliberately flat per-project task list — name, optional
      `budgetedHours`, an optional per-task `billingRate` override,
      done/not-done). An optional `projectId`/`taskId` was added directly to
      `invoice_lines`, `bill_lines`, and `expense_claim_lines` — **all
      three**, since none turned out to be riskier to touch than the
      others; each is additive (nullable columns, no change to existing
      callers' behavior) and is exercised by the full existing property/unit
      suite with zero regressions. `timesheet_entries` (org-scoped:
      employee, project, optional task, `entryDate`, `hours`, optional
      `startedAt`/`endedAt` for the timer path, `notes`, `billable`, status
      enum DRAFT/SUBMITTED/APPROVED/REJECTED/INVOICED, and
      `invoiceId`/`invoiceLineId` set once a line is billed). All three new
      tables are RLS-enabled + FORCEd + policy + `mm_app`-granted
      (drizzle/0021–0022), verified by the `db:migrate` tenant-isolation
      audit, now **51 of 55** organization-scoped tables (up from 46).
    - **Design decision — dedicated FK columns, not the dimension system**:
      Phase 5 Slice 2's generic `dimensions`/`dimension_values` +
      `journal_line_dimensions` exists for exactly this kind of
      "which business unit does this line belong to" tagging, and was
      seriously considered. A dedicated `projectId`/`taskId` FK on the
      cost-bearing line tables was chosen instead, documented here and in
      `docs/database.md`, because: (1) a project's billable time needs a
      *structural*, not just reporting-time, link to the invoice line it
      produced (`timesheetEntries.invoiceLineId` — the mechanism that makes
      double-billing structurally impossible) — the dimension system has no
      equivalent concept of "this journal line's dimension tag is the
      proof a different row was already settled"; (2) project cost/revenue
      queries (`profitability-service.ts`) need to join and filter
      efficiently on one indexed foreign key per cost-bearing *line table*,
      not fan out through a separate tagging join table per journal line —
      the dimension system tags posted `journal_lines`, one level removed
      from the invoice/bill/expense-claim *line* a human actually edits,
      which would require re-deriving "which invoice line" from "which
      journal line" anyway; (3) a project is a first-class, queryable
      business entity with its own lifecycle (budget, status, tasks, a
      billing rate) — modeling it as a `dimension_value` would mean bolting
      all of that back on as side tables keyed by a dimension value id
      instead of a real `projects` table. The dimension system remains the
      right tool for open-ended, user-defined tags (cost centre, region,
      department); `projectId` is the right tool for a specific, structural,
      product-level concept the domain layer needs to reason about directly.
- [x] **`ProjectService`** (`src/domain/projects/project-service.ts`):
      create/update a project (unique code enforced per org, customer must
      be an active CUSTOMER/BOTH contact), open/hold/complete/cancel via
      `setStatus`, and create/update a task. New permissions `project:read`/
      `project:manage` (`src/domain/permissions/roles.ts`), granted to
      OWNER/ADMINISTRATOR/ACCOUNTANT/BOOKKEEPER/MANAGER/ACCOUNTS_RECEIVABLE
      (manage) and ACCOUNTS_PAYABLE/PAYROLL_MANAGER/EMPLOYEE/READ_ONLY
      (read-only, since AP needs to attribute bills and an employee needs to
      see which projects they can log time against).
- [x] **`TimesheetService`** (`src/domain/projects/timesheet-service.ts`):
      manual entry and a real start/stop timer — **the same underlying row
      either way**, per master spec §23 (`startTimer`/`stopTimer` fill in
      `startedAt`/`endedAt` and derive `hours` via
      `time-calculations.ts`'s `calculateDurationHours`, a pure,
      `decimal.js`-based function so a long-running timer never accumulates
      float error). Submit → a manager's single-approver
      approve/reject, reusing the exact pattern already established for
      expense claims (`expense_claim:approve`'s mirror, `timesheet:approve`
      — a distinct permission from `timesheet:manage` so nobody approves
      their own time). `DRAFT`/`REJECTED` are the only editable statuses;
      `APPROVED`/`INVOICED` are immutable. New permissions `timesheet:read`/
      `timesheet:manage`/`timesheet:approve`.
- [x] **The integration (master spec §23's explicit requirement)**:
      `ProjectTimeBillingService.createInvoiceFromUnbilledTime`
      (`src/domain/projects/project-time-billing-service.ts`) pulls every
      APPROVED, BILLABLE, not-yet-INVOICED timesheet entry for a project
      (optionally date-bounded), groups it by task (or one line per entry,
      caller's choice) at the task's `billingRate` override or the
      project's `defaultHourlyRate`, and creates the invoice through
      `InvoiceService.create` — the exact same path, exact same validation,
      as any manually typed invoice. It is still a DRAFT requiring separate
      `InvoiceService.approveAndPost`; nothing here posts to the ledger by
      itself. Every selected entry is stamped `status: INVOICED` with
      `invoiceId`/`invoiceLineId` set, and the unbilled-time query
      (`queryUnbilledEntries`) filters on `invoiceId IS NULL` — so a second
      run, even with an overlapping or identical date range, structurally
      cannot reselect an entry already claimed. Proven by an integration
      test that runs the action twice and asserts the second run finds
      nothing left to bill. Correcting already-billed time means voiding
      the generated invoice (`InvoiceService.voidInvoice`, which reverses
      its journal, never edits it) and logging fresh time — voiding does
      **not** auto-revert the entries back to APPROVED in this slice
      (a documented, deliberate scope cut rather than a half-built
      auto-reversal that could resurrect an entry onto a second invoice).
- [x] **Project profitability** (`src/domain/projects/
      profitability-service.ts` + `profitability-calculations.ts`): master
      spec §22's Estimated vs. Actual table — Revenue/Cost/Profit/Margin on
      both sides, a signed variance, and a plain-language explanation per
      line (e.g. "Cost exceeded estimate by $X", with the same mechanism
      able to produce a labelled line like "Labour exceeded estimate by
      $3,200" wherever a caller has a real estimated/actual pair for that
      category). "Actual" is summed live from `invoice_lines`/`bill_lines`/
      `expense_claim_lines` whose `projectId` matches and whose parent
      document has actually posted (not DRAFT, not VOID) — it can never
      drift from the ledger because nothing is cached. **Honest scope cut**:
      Actual Cost does **not** include a dollar figure for logged labour —
      this codebase has no per-employee hourly *cost* rate (only a *billing*
      rate), so there is no honest number to attribute it at; billable
      hours and non-billable hours are both reported separately instead, and
      once billable time is actually invoiced its dollar value appears in
      Actual Revenue the normal way. A future slice that adds an employee
      cost rate can fold labour into Actual Cost without changing this
      service's shape.
- [x] **UI** (`src/app/[orgSlug]/projects/`): a projects list (filterable by
      status), a new-project form, and a project detail page with the
      Estimated-vs-Actual table, task list + add-task form, a real
      start/stop timer plus a manual time-entry form, a timesheet-entries
      table with submit/approve/reject actions, and the "create invoice
      from unbilled time" form (account/tax-code pickers, optional date
      range, previews the un-invoiced hours total before submitting). The
      `Operations` nav placeholder is now the real `Projects` section.
- [x] Tests: unit (`calculateDurationHours`'s banker's-rounding duration
      math and its reject-a-backwards-range error; `selectUnbilledEntries`'s
      pure filter against a crafted mix of draft/submitted/approved/
      already-invoiced/non-billable/wrong-project/out-of-range entries;
      `computeProjectVariance`'s margin-is-null-not-zero-on-zero-revenue
      case, signed variance, and plain-language explanations including a
      per-category breakdown line) and integration against the real test
      database (create a project with a budget; log time both manually and
      via start/stop timer; submit/approve; generate an invoice from
      unbilled time and confirm its total and that entries are marked
      INVOICED; **re-run the action and confirm it finds nothing left to
      bill**; attribute a posted bill to a project and confirm Actual Cost
      reflects it before vs. after posting; confirm Actual Revenue only
      appears once the time-billed invoice is itself posted; a tenant-
      isolation case for all three new tables). The full existing suite
      (557 tests total after this slice, up from 533) still passes.
- [x] `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
      all pass. Smoke-tested for real against a local Postgres: created a
      project with a $20,000/$12,000 budget and a $150/hr default rate,
      logged 5h + 3h of manual billable time, submitted and approved both,
      generated a draft invoice from unbilled time (8h × $150 = $1,200,
      correct), confirmed a second invoicing run found zero unbilled time
      left, posted a $2,000 bill attributed to the project and confirmed
      Actual Cost moved from $0 to $2,000 only after posting (not while the
      bill was still DRAFT), and posted the time-billed invoice and
      confirmed Actual Revenue moved from $0 to $1,500 only then.

**Explicitly deferred, not attempted shallow**:

- **Inventory** (SKU/costing methods — FIFO/weighted-average/standard —
  landed costs, warehouses/locations): a large, mostly-independent domain
  in its own right per master spec, intentionally left for its own slice
  rather than a stub that would need to be half-rebuilt later.
- **Fixed assets** (asset register, depreciation schedules/methods,
  disposal): same reasoning — independent of projects/time-tracking, large
  enough to deserve its own vertical slice.
- **A full task-management system**: dependencies, assignees beyond the
  implicit link a timesheet entry already carries, Gantt-style planning.
  `project_tasks` is deliberately a flat list — just enough for "which task
  was this time logged against."
- **A rate-card system beyond a simple default/task-override hourly rate**:
  tiered rates by employee/skill/date range, multi-currency billing rates,
  etc. — `projects.defaultHourlyRate` and `project_tasks.billingRate` are
  the full extent of this slice's billing-rate mechanism.
- **Subcontractor-specific workflows**: no special subcontractor concept
  was added — a subcontractor's cost is just a normal bill attributed to
  the project via `bill_lines.projectId`, which is all master spec §22
  actually asks for here.
- **Labour cost in Actual Cost**: see `profitability-service.ts`'s doc
  comment above — no employee hourly cost-rate concept exists yet, so this
  is an honest omission rather than a fabricated number.
- **Auto-reverting INVOICED timesheet entries when their invoice is
  voided**: documented above under the integration service.

### Slice 2 — Inventory (complete, scoped down hard from master spec §20/§21)

Master spec §20/§21 describes a very large feature — SKU/barcode/variants/
serial/lot tracking, multiple warehouses/locations/bins, stock transfers,
backorders, damaged stock, landed costs, reorder points, bundles/kits, stock
takes, multiple costing methods, sales-velocity stockout forecasting. This
slice builds a production-quality **core** — a real perpetual-inventory
system with correct GL postings — and explicitly defers the rest (listed
below) rather than shallow-covering everything.

- [x] **Schema** (`src/db/schema.ts`): `products` (org-scoped, unique-per-org
      `sku`, `type` enum TRACKED_INVENTORY/NON_INVENTORY/SERVICE,
      `costingMethod` enum — currently only `WEIGHTED_AVERAGE`, see below —
      `sellPrice`, `revenueAccountId` always required,
      `inventoryAssetAccountId`/`cogsAccountId` required for
      TRACKED_INVENTORY, `purchaseAccountId` required otherwise,
      `quantityOnHand`/`averageUnitCost` as the perpetually-maintained
      current state, `reorderPoint`/`reorderQuantity`,
      `preferredSupplierContactId`, `isActive`), `inventory_movements` (the
      append-only audit trail of every PURCHASE/SALE/ADJUSTMENT, with a
      post-movement balance snapshot for transparency), and
      `inventory_adjustments` (a manual correction, always with a `reason`
      and its own posted journal). An optional `productId` was added
      directly to `invoice_lines` and `bill_lines`. All three new tables
      are RLS-enabled + FORCEd + policy + `mm_app`-granted
      (drizzle/0023–0024), verified by the `db:migrate` tenant-isolation
      audit, now **54 of 58** organization-scoped tables (up from 51).
    - **Design decision — dedicated FK, not the dimension system**: same
      reasoning as Phase 7 Slice 1's `projectId`/`taskId` (see that
      section above and `docs/database.md`) — a product needs a
      *structural* link invoice/bill posting can resolve accounts and
      trigger stock movements from, not just a reporting-time tag. The
      dimension system stays the tool for open-ended user-defined tags;
      `productId` is the tool for a specific, structural, product-level
      concept (`InventoryService` reads it to decide whether to move
      stock at all, and which accounts to post to).
- [x] **`ProductService`** (`src/domain/inventory/product-service.ts`):
      create/update/deactivate/reactivate, enforcing a unique SKU per org
      and the account wiring each `type` requires (see schema doc comment
      above) — a product's `type` cannot be changed while it has non-zero
      stock. New permissions `product:read`/`product:manage`,
      `inventory:read`/`inventory:manage` (`src/domain/permissions/
      roles.ts`), granted to OWNER/ADMINISTRATOR/ACCOUNTANT/BOOKKEEPER/
      ACCOUNTS_PAYABLE (manage) and MANAGER/ACCOUNTS_RECEIVABLE/READ_ONLY
      (read-only, since a salesperson needs to pick products on an invoice
      without managing the catalog).
- [x] **Single-location, weighted-average perpetual costing**
      (`src/domain/inventory/costing.ts` — pure, `decimal.js`-based,
      unit-tested directly — and `inventory-service.ts`, which applies it
      transactionally under a `SELECT ... FOR UPDATE` row lock on the
      product so two concurrent sales/purchases of the same product can't
      race the weighted-average recomputation). **Explicitly one implicit
      location per org** — no warehouse/bin model exists, so there is
      nothing to allocate across. **Explicitly weighted-average only**:
      `costingMethod` is an enum with a single value today specifically so
      FIFO (master spec §20) can be added later as a second enum value
      with no column/table restructuring, rather than half-building both
      methods side by side now.
    - **Purchase** (a bill line with `productId` set to a
      TRACKED_INVENTORY product): `BillService` resolves that line's
      `accountId` to the product's own `inventoryAssetAccountId` — never
      whatever account the caller passed — so the bill's own existing
      debit aggregation already lands on the right asset account with no
      extra journal lines. `InventoryService.recordPurchase` then
      increases quantity and recomputes the weighted average from the
      line's own unit price, inside the SAME transaction as the bill's
      posting.
    - **Sale** (an invoice line with `productId` set to a
      TRACKED_INVENTORY product): `InvoiceService` resolves the line's
      `accountId` to the product's `revenueAccountId` for the normal
      revenue credit, and separately calls `InventoryService.recordSale`,
      which decreases quantity (valued at the CURRENT weighted-average
      cost — a sale never changes the average itself) and returns the
      COGS amount. `InvoiceService.approveAndPost` adds that COGS
      debit/inventory-asset credit to the exact SAME journal entry as the
      sale's own revenue/tax lines — perpetual inventory, COGS posted at
      the moment of sale, never a separate disconnected process.
    - **Oversell rejection**: `InventoryService.recordSale` (via
      `costing.ts`'s `applySale`) refuses, with `InsufficientStockError`
      naming the SKU/available/requested quantities, any sale that would
      take quantity negative — the whole transaction (including the
      invoice's own posting) rolls back. **No backorder support** — an
      oversell is always refused outright, never queued.
    - **Void is refused for a tracked-inventory line**: voiding a posted
      invoice/bill with any TRACKED_INVENTORY line throws
      `VoidWouldDesyncInventoryError` — correctly reversing both the
      weighted-average cost history and a quantity a later movement may
      have built on needs either a correcting-movement scheme or full
      history replay, which is deferred. Use a manual
      `InventoryAdjustmentService` correction for stock, and consult an
      accountant for the revenue/COGS reversal, in the meantime — an
      honest refusal rather than an incorrect reversal.
- [x] **`InventoryAdjustmentService`**
      (`src/domain/inventory/inventory-adjustment-service.ts`): a manual
      quantity correction (stocktake, damage, shrinkage) — org-scoped,
      always requires a `reason`, always posts its own small balanced
      journal through `PostingService` (debiting/crediting the inventory
      asset account against a caller-chosen adjustment account), audited.
      An increasing adjustment requires a stated unit cost (what the found
      stock is valued at); a decreasing one is valued at the current
      weighted average and is refused the same way an oversell is if it
      would take quantity negative.
- [x] **Inventory Valuation report**
      (`src/domain/inventory/valuation-service.ts`): on-hand quantity ×
      weighted-average cost per product and in aggregate, **reconciled
      against the inventory asset account's own posted GL balance**, the
      same spirit as Phase 5's Balance Sheet equation check. Grouped by
      `inventoryAssetAccountId` (several products may share one account);
      a non-zero difference is flagged as a real bug, never silently
      absorbed, the same discipline as that check.
- [x] **Reorder alerting** (`src/domain/inventory/
      reorder-alert-service.ts`) — the one piece of master spec §21
      "Inventory Intelligence" that's cheaply real without a forecasting
      model: a deterministic `quantityOnHand <= reorderPoint` list for
      active TRACKED_INVENTORY products with a reorder point set. No
      "likely to reach zero stock in approximately N days" prediction —
      that needs real sales-velocity forecasting (a trend over historical
      SALE movements, seasonality, lead time), a materially bigger
      feature, deferred rather than faked with a guessed number.
- [x] **UI** (`src/app/[orgSlug]/inventory/`): a product catalog (filterable
      by nothing yet, just a flat list with on-hand qty/avg cost),
      a new-product form (type-aware account wiring with inline guidance),
      a product detail page (stock summary, a manual-adjustment form, full
      movement history), a Valuation report page (the GL reconciliation
      front and center, flagged red if it ever fails), and a Reorder
      Alerts page. The existing invoice/bill line editor
      (`InvoiceLineEditor`) gained an optional per-line Product picker —
      selecting one clears and disables that line's own account field,
      since the server resolves it from the product instead; this only
      renders on the invoice/bill "new" pages (quotes, purchase orders,
      recurring templates and the draft-edit pages don't offer product
      selection in this slice — a product chosen while originally creating
      an invoice/bill line is not currently preserved across a later
      edit-and-resave of that same draft, a known minor gap rather than a
      silent data-loss risk since the line's own `productId` column is
      simply left as whatever was last persisted if the edit form omits
      it). A new "Inventory" nav section was added alongside Projects.
- [x] Tests: unit (`costing.ts`'s weighted-average recomputation across
      multiple purchases at different costs, a sale leaving the average
      unchanged, fractional-quantity exactness, oversell/negative-stock
      rejection, increasing/decreasing adjustment math, the
      `assertWeightedAverage` guard) and integration against the real test
      database (buy stock via a bill and confirm quantity/average cost;
      a second purchase at a different cost recomputes the average
      correctly; sell stock via an invoice and confirm quantity decreases,
      COGS posts in the SAME journal entry as the sale, and the GL
      reflects both the inventory-asset credit and the trial balance;
      gross margin on a P&L for that period is correct; **attempt to
      oversell and confirm rejection with nothing posted**; a manual
      adjustment — both increasing and decreasing — posts correctly and
      updates quantity; a reason is required; **inventory valuation
      reconciles exactly to the GL inventory asset account balance across
      a sequence of two purchases, a sale and an adjustment**; reorder
      alerting flags exactly the right products as stock crosses the
      threshold; deactivate/reactivate; voiding a posted invoice or bill
      with a tracked-inventory line is refused; a tenant-isolation case
      for all three new tables). The full existing suite (588 tests total
      after this slice, up from 557) still passes.
- [x] `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
      all pass. Smoke-tested for real against a local Postgres: created a
      TRACKED_INVENTORY product with its own inventory-asset/COGS/revenue
      accounts, bought 10 units @ $5.00 via a bill (quantity → 10, average
      cost → $5.00, inventory asset account debited $50.00), bought a
      further 10 @ $7.00 (quantity → 20, average cost recomputed to
      $6.00), sold 4 units @ $20.00 via an invoice (quantity → 16, COGS
      $24.00 debited and inventory asset credited $24.00 in the SAME
      journal as the $80.00 revenue credit, P&L gross margin correct at
      $56.00), attempted to sell 50 more units and confirmed
      `InsufficientStockError` with nothing posted, posted a −2 unit
      shrinkage adjustment (inventory asset credited $12.00 at the $6.00
      average, quantity → 14), and confirmed the Valuation report's
      $84.00 total reconciles exactly to the inventory asset account's own
      $84.00 GL balance (50 + 70 − 24 − 12).

**Explicitly deferred, not attempted shallow**:

- **Multi-warehouse/location/bin tracking**: one implicit location per org
  this slice; `products.quantityOnHand` has nowhere to be split across
  locations yet. A real multi-location slice needs its own `locations`
  table, a `warehouseId` on every movement, and a materially different
  valuation-reconciliation query (per-location, not just per-account).
- **Barcode scanning**: no barcode field or scan workflow exists; `sku` is
  typed, not scanned.
- **Serial/lot/batch tracking**: `inventory_movements` has no serial/lot
  identity — a unit of a tracked product is fungible with every other unit
  of the same product, which is what weighted-average costing itself
  assumes.
- **Stock transfers between locations**: meaningless without locations;
  deferred alongside them.
- **Backorder support**: documented above — an oversell is always refused,
  never queued or partially fulfilled.
- **A damaged-stock-specific workflow beyond the generic adjustment**:
  `InventoryAdjustmentService` covers damage/shrinkage/stocktake correction
  identically; no separate damage-claim or write-off approval flow exists.
- **Landed costs** (freight/duty/insurance allocated into unit cost): a
  purchase's unit cost is exactly the bill line's own unit price; nothing
  apportions a separate freight bill into it.
- **Bundles/kits/assemblies**: a product is a single sellable/purchasable
  item; there is no "this product's sale consumes N units of several
  component products" concept.
- **A formal stock-take/cycle-count workflow**: no count-sheet, variance
  report, or count-approval flow — a stocktake correction is just a normal
  `InventoryAdjustmentService.create` call with that reason typed in.
- **FIFO costing**: `inventoryCostingMethodEnum` has a single value
  (`WEIGHTED_AVERAGE`) specifically so FIFO can be added as a second value
  later without restructuring — see this slice's costing doc comment.
- **Sales-velocity-based stockout prediction** (master spec §21's "likely
  to reach zero stock in approximately N days"): needs real forecasting
  logic (a trend over SALE movement history, seasonality, lead time), not
  a guess — deferred rather than faked. `ReorderAlertService`'s
  deterministic `quantityOnHand <= reorderPoint` check is this slice's
  entire "Inventory Intelligence" surface.
- **Preserving a line's `productId` across a draft edit-and-resave** on
  the invoice/bill edit pages — see the UI note above.

### Slice 3 — Fixed Assets (complete, scoped down from master spec §28) — **Phase 7 is now fully complete**

Master spec §28 describes acquisition, asset classes, depreciation methods,
useful life, opening value, accumulated depreciation, disposal, write-off,
transfer, and location/serial reference, plus "generate depreciation
journals automatically." This slice builds a production-quality **core** —
a real asset register with correct, idempotent, reconciled GL postings for
depreciation and disposal — and explicitly defers the rest (listed below).

- [x] **Schema** (`src/db/schema.ts`): `fixed_asset_classes` (org-scoped: a
      simple per-category template — name, default depreciation method,
      default useful life in months — never re-consulted after an asset is
      registered, so changing a class never retroactively changes an
      existing asset) and `fixed_assets` (org-scoped: asset class, name/
      description, acquisition date and cost, useful life in **months** —
      the one consistent unit this slice uses, so a sub-year life like an
      18-month fit-out is representable exactly — depreciation method,
      residual value, status enum ACTIVE/DISPOSED/WRITTEN_OFF, the three
      GL accounts it posts to (asset/cost, accumulated depreciation,
      depreciation expense), a perpetually-maintained
      `accumulatedDepreciation` running total (same pattern as
      `products.quantityOnHand`), optional location/serial reference,
      optional `sourceBillLineId` traceability link, and disposal
      proceeds/gain-loss/journal columns once terminal) and
      `depreciation_entries` (the append-only per-asset-per-period audit
      trail behind that running total, with a `UNIQUE
      (organizationId, assetId, periodStart)` index that makes idempotency
      a structural property, not just a convention — see below). All three
      new tables are RLS-enabled + FORCEd + policy + `mm_app`-granted
      (drizzle/0025–0026), verified by the `db:migrate` tenant-isolation
      audit, now **57 of 61** organization-scoped tables (up from 54).
    - **Design decision — the register never posts the acquisition
      itself**: unlike inventory (where `InventoryService` posts alongside
      `BillService`/`InvoiceService` in the same transaction), a fixed
      asset's acquisition is **already** posted by whatever put the cost
      into the designated asset account — a bill line coded directly to it
      (the normal path) or a manual journal/opening-balance import (the
      standalone path, required to exist since not every asset arrives via
      a bill in this system). `FixedAssetService.registerAsset`/
      `registerFromBillLine` only ever create the subsidiary-ledger record;
      `FixedAssetRegisterService` is the correctness check that confirms
      the register and the GL agree, the same spirit as
      `InventoryValuationService` (`docs/accounting-engine.md` §10) but a
      different mechanism — see §11 there for the full reasoning.
    - **Depreciation method — straight-line only**: `depreciationMethodEnum`
      has a single value (`STRAIGHT_LINE`) today, the same "enum with one
      value now" pattern `inventoryCostingMethodEnum` uses for FIFO.
      Declining-balance (which re-bases off net book value every period,
      not a fixed monthly amount) and units-of-production/sum-of-years-
      digits (which need an input this codebase has no honest source for)
      were judged to dilute this slice's quality if half-built alongside
      straight-line, rather than a deliberate exclusion — see
      `depreciation-calculations.ts`'s doc comment.
- [x] **`FixedAssetClassService`** (`src/domain/fixed-assets/
      asset-class-service.ts`): create/update/deactivate/reactivate a
      class. **`FixedAssetService`** (`fixed-asset-service.ts`):
      `registerAsset` (standalone) and `registerFromBillLine` (reads an
      already-posted bill line's own `accountId`/`lineAmount`/the bill's
      `issueDate`, confirms the line was coded to the stated asset account,
      and links them — no second posting), `updateDetails` (name/
      description/location/serial — never the financial fields, since
      editing cost/date/life/method after depreciation has started would
      desynchronize `depreciation_entries`' history), `disposeAsset`, and
      `writeOffAsset`. New permissions `fixed_asset:read`/
      `fixed_asset:manage` (`src/domain/permissions/roles.ts`), granted to
      OWNER/ADMINISTRATOR/ACCOUNTANT/BOOKKEEPER/ACCOUNTS_PAYABLE (manage,
      since assets most often arrive via a bill) and MANAGER/
      ACCOUNTS_RECEIVABLE/EMPLOYEE/READ_ONLY (read-only).
- [x] **`DepreciationService.runForPeriod`** (`depreciation-service.ts`):
      the on-demand precursor to real scheduling (no job queue exists, same
      reasoning as `RecurringInvoiceService`/`RecurringBillService.
      generateDue`) — a human-triggered "run depreciation for calendar
      month X" that computes straight-line depreciation per ACTIVE asset
      (`depreciation-calculations.ts`'s `calculateStraightLineDepreciation`:
      `(cost - residual) / usefulLifeMonths` per month, prorated by whole
      days for a mid-month acquisition, capped so accumulated depreciation
      never exceeds the depreciable base) and posts **one combined journal
      entry per run**, one debit-expense/credit-accumulated-depreciation
      line pair per asset with a non-zero charge — not a separate entry per
      asset, so a business running this across a whole register reviews one
      journal, not N. **Idempotent per asset per period structurally**: a
      `depreciation_entries` row (even a $0 one, for an asset not yet
      acquired or already fully depreciated) is checked for and, if
      present, that asset is skipped outright before any computation —
      proven by an integration test that runs the same month twice and
      confirms only one journal and one row per asset exist afterward.
- [x] **Disposal / write-off**: `disposeAsset` (sale) removes the asset's
      full cost and accumulated depreciation and recognizes
      `proceeds - netBookValue` as a gain (credited) or loss (debited) via
      `PostingService`; `writeOffAsset` is the same removal with no
      proceeds line, the full remaining net book value always posting as a
      loss. Both are one-way and terminal (`fixedAssetStatusEnum` has no
      path back to ACTIVE) — a mistaken disposal is corrected with a manual
      correcting journal, never an edit to the original event, the same
      reversal-only discipline `PostingService.reverseEntry` enforces
      everywhere else.
- [x] **Reporting** (`fixed-asset-register-service.ts`): the Fixed Asset
      Register (every ACTIVE asset's cost/accumulated depreciation/net book
      value, reconciled in aggregate — grouped by asset-account/
      accumulated-depreciation-account pair — against those accounts' own
      posted GL balances, the same correctness-check spirit as
      `InventoryValuationService` and the Balance Sheet equation check) and
      a per-asset depreciation schedule (`projectDepreciationSchedule`:
      real history plus pure-arithmetic projection to the end of useful
      life, landing exactly at residual value).
- [x] **UI** (`src/app/[orgSlug]/fixed-assets/`): the register with its GL
      reconciliation banner, asset classes list/create, a "register asset"
      form (standalone or from a posted-bill-line picker that only lists
      ASSET-coded lines not already registered), an asset detail page
      (financials, editable non-financial details, dispose/write-off forms,
      the full depreciation schedule), and an on-demand "run depreciation
      for month X" page. The `Fixed Assets` nav section is new.
- [x] Tests: unit (`calculateStraightLineDepreciation`'s even monthly
      amount, residual-value reduction of the depreciable base, mid-period
      proration by whole days, not-yet-acquired and already-fully-
      depreciated zero cases, capping at the final period, and input
      validation; `calculateDisposalGainLoss`'s gain/loss/break-even cases;
      `calculateWriteOffLoss`'s full-loss and already-fully-depreciated
      cases; `projectDepreciationSchedule`'s exact full-depreciation-to-
      residual-value property, including the one-extra-period case a
      prorated first period needs) and integration against the real test
      database (register an asset both standalone and from a posted bill
      line; refuse registering from a DRAFT bill line; run depreciation for
      a period and confirm the journal and new net book value; **run the
      same period again and confirm no duplicate posting**; run a second
      period and confirm accumulated depreciation is cumulative; dispose of
      an asset with proceeds above and below net book value and confirm
      the gain/loss posts correctly; write off an asset and confirm the
      full remaining net book value posts as a loss; refuse depreciating/
      disposing/writing off a non-ACTIVE asset; confirm the register's
      total net book value reconciles exactly to the GL, including after a
      disposal removes an asset from both; confirm the depreciation
      schedule projects to zero/residual value at the end of useful life; a
      tenant-isolation case for all three new tables). The full existing
      suite (619 tests total after this slice, up from 588) still passes.
- [x] `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
      all pass. Smoke-tested for real against a local Postgres (a script
      exercising the real services, not just the test suite): posted a
      $12,000 opening-balance journal to a Motor Vehicles cost account,
      registered a Delivery Van asset against it (60-month straight-line,
      no residual value), ran depreciation for January 2026 ($200.00
      posted, debit Depreciation Expense / credit Accumulated
      Depreciation), ran it again for February 2026 (another $200.00,
      cumulative $400.00 — confirmed NOT double-posted for January), and
      confirmed the Fixed Asset Register's total net book value
      ($11,600.00) reconciled exactly to the GL. Disposed of the asset for
      $12,000.00 proceeds against a $11,600.00 net book value and confirmed
      a $400.00 gain posted correctly, the asset and accumulated
      depreciation accounts both returned to $0.00, and the register (now
      with zero assets) still reconciled exactly.

**Explicitly deferred, not attempted shallow**:

- **A tracked asset-transfer workflow**: `fixedAssets.locationReference` is
  a plain editable text field (see `updateDetails`) — moving an asset is
  just editing it, with no dedicated transfer event, approval, or audit
  trail beyond the ordinary `fixed_asset.updated` audit-log entry. A real
  transfer workflow (from/to location, requested-by/approved-by, its own
  history) is independent scope deserving its own design, not a field edit
  dressed up as one.
- **Automatic/scheduled depreciation runs**: the same job-queue gap every
  recurring process in this codebase has (`RecurringInvoiceService`/
  `RecurringBillService.generateDue`) — `DepreciationService.runForPeriod`
  is deliberately human-triggered, "run month X now," never a cron job.
- **Any depreciation method beyond straight-line**: declining-balance,
  units-of-production, sum-of-years-digits — see this slice's design-
  decision note above. `depreciationMethodEnum` is a Postgres enum with a
  single value specifically so a second method can be added later without
  restructuring.
- **Asset revaluation/impairment**: no mechanism to write an asset's
  carrying value up or down outside of ordinary depreciation and disposal/
  write-off — a revaluation reserve, impairment testing, and the resulting
  equity-side postings are all out of scope this slice.
- **A depreciation-run preview/undo**: `runForPeriod` posts immediately
  once called — the run itself is the deliberate human action master spec
  §28 asks for ("generate depreciation journals"), with no draft/review
  step to preserve, unlike `RecurringBillService.generateDue` which
  produces a DRAFT bill a human still approves separately. A mistaken run
  is corrected with `PostingService.reverseEntry` on the resulting journal
  plus a manual correction to `accumulatedDepreciation`, not a built-in
  undo.

## Phase 8 — Payroll & Australia Compliance

### Slice 1 — AU Payroll foundation (complete, scoped per this slice's brief)

Employee records, an effective-date-controlled AU tax/super rule engine,
PAYG withholding, superannuation guarantee (with the quarterly contribution
base cap), NES leave accrual, on-demand pay runs posting through
`PostingService`, and an STP Phase 2-SHAPED report. This phase is explicitly
different from every other phase built so far: it is NOT built from
well-known double-entry accounting principles. Every tax/super figure below
was supplied already verified against ato.gov.au and cross-checked against
independent accounting-firm sources, and is used EXACTLY as given — nothing
was recalled from training data or "rounded to a nice number." Anything not
supplied with a verified figure is flagged below as unresolved, never
guessed at.

**Verified figures used (reproduced from the rule sets seeded in
`drizzle/0029_payroll_slice1_seed_au_rule_sets.sql`, and in
`payroll_tax_rule_sets.source_citation`/`requires_verification_note` on each
row itself — the data is self-documenting, not just this doc):**

- **Superannuation Guarantee**: 12.00% for both FY2025-26 and FY2026-27
  (ato.gov.au "Super guarantee" page — the final scheduled increase to 12%
  already took effect 1 July 2025). FY2025-26 quarterly maximum contribution
  base: $62,500/quarter (max quarterly SG = $7,500.00).
- **Resident individual income tax brackets, FY2025-26** (1 Jul 2025 – 30
  Jun 2026): $0-$18,200 nil; $18,201-$45,000 16%; $45,001-$135,000 30%;
  $135,001-$190,000 37%; $190,001+ 45% — ato.gov.au, cross-confirmed.
- **Resident individual income tax brackets, FY2026-27** (1 Jul 2026 – 30
  Jun 2027, the current financial year): identical except the
  $18,201-$45,000 bracket drops to 15% (ato.gov.au "Personal income tax —
  new tax cuts" legislation page, already in effect). The cumulative "plus
  $X" base amounts ($4,020/$31,020/$51,370) are NOT hardcoded anywhere —
  `BracketCalculations.cumulativeBaseAt` derives them from the marginal
  rates/thresholds at read time, and
  `src/tests/unit/payroll/bracket-calculations.test.ts` independently
  reproduces all three figures from nothing else, proving the brief's hand
  arithmetic rather than trusting it.
- **Medicare levy**: 2.0% standard rate (both years, no change identified);
  FY2025-26 singles low-income thresholds: nil below $28,011, full 2% at/
  above $35,013. The phase-in between the two ($$(income-lower)\times
  10\%$$, capped at the standard amount) is implemented
  (`annualMedicareLevy` in `payg-calculations.ts`) but is explicitly flagged
  in code as a widely-documented general mechanism, NOT one of the
  ATO-verified figures this slice was handed — treat it as needing
  independent verification before real use, separately from the brackets/SG
  rate/levy-rate/thresholds themselves, which were verified.
- **NES leave (Fair Work Act)**: 4 weeks/year annual leave (152 hrs/year
  full-time), 10 days/year personal/carer's leave (76 hrs/year full-time),
  both accrued progressively per pay period and pro-rated for part-time by
  standard hours/week. Long-standing, low-regulatory-change-risk figures,
  still cited in `leave-calculations.ts`.

**Explicitly UNRESOLVED — do not treat as settled, and don't let a future
session paper over this:**

- **FY2026-27 "Payday Super"**: the ATO's own material signals a move to
  calculating/remitting SG per payday rather than quarterly, with a
  $270,830 ANNUAL contribution-base figure mentioned instead of a quarterly
  one, starting around this financial year. The exact mechanics were **not
  resolved** during this slice's research. This slice deliberately does
  **not** implement a per-payday SG obligation model. The FY2026-27 rule
  set seeded in the database carries the unchanged 12% rate with the
  FY2025-26 quarterly-cadence mechanism and cap as a documented
  approximation — `payrollTaxRuleSets.requiresVerificationNote` is non-null
  on that row specifically so this can never silently look "finished": a
  registered tax agent or payroll provider MUST confirm the real FY2026-27
  cadence/cap mechanics before this software is used for real FY2026-27
  payroll.
- **PAYG withholding method**: `calculatePaygWithholding`
  (`src/domain/payroll/payg-calculations.ts`) uses the **annualized-bracket
  method** — annualize the period's gross pay, apply the resolved rule
  set's brackets, add the Medicare levy, divide back down — which the ATO's
  own Schedule 1 documentation acknowledges as an acceptable withholding
  method. **It is NOT a byte-for-byte implementation of the ATO's published
  NAT 1004 per-period coefficient tables** — those could not be
  independently fetched/verified during this research pass (ato.gov.au
  blocked direct fetching). Minor rounding differences from the official
  published per-period lookup tables are expected and accepted. This
  disclaimer is shown prominently in the pay run and STP-report UI, not
  only here.
- **"No tax-free threshold" withholding**: the ATO publishes a genuinely
  separate withholding schedule for an employee who hasn't claimed the
  tax-free threshold, with its own coefficients this slice does not have
  verified figures for. `withoutTaxFreeThreshold` in `payg-calculations.ts`
  approximates this by simply dropping the 0%-rate band (so the next
  bracket's rate applies from the first dollar) — a documented
  simplification, not the real schedule. Flagged in code; needs
  verification before real use for any employee who doesn't claim the
  threshold.

**What's built:**

- `payroll_tax_rule_sets`/`payroll_tax_brackets` (`src/db/schema.ts`): a
  jurisdiction + effective-date-controlled rule set (master spec §26's
  architecture, built for AU only — scope). Deliberately NOT
  organization-scoped (shared regulatory reference data, not per-tenant
  data) and so correctly exempt from the tenant-isolation RLS audit, the
  same way `organizations`/`users` are. `TaxRuleService.resolve(jurisdiction,
  payDate)` throws rather than extrapolating for any date outside the two
  seeded financial years.
- `employees` (its own table, not a repurposed `contacts` row — see that
  table's schema comment for why: different shape, different sensitivity,
  and folding payroll fields onto `contacts` would widen the blast radius
  of every contact-reading code path, including Phase 6's AI read-only
  tools, to having to reason about a possible TFN). `EmployeeService`:
  create/edit/terminate. TFN and bank account number are treated like a
  password: redacted in `AuditService.REDACTED_FIELDS`
  (`tfn`/`bankAccountNumber`/`bankBsb`), never placed on a read for a role
  without `employee:manage` (only `tfnMasked`/`bankAccountNumberMasked`,
  last-4 digits, are), and the UI only ever renders the full value to a
  role that can manage payroll.
- `BracketCalculations`/`PaygCalculations`/`SuperCalculations`/
  `LeaveCalculations` (`src/domain/payroll/`): pure, independently
  unit-tested calculation modules — no database, no side effects.
- `PayRunService` (`src/domain/payroll/pay-run-service.ts`): the on-demand
  "run payroll for period X" action, mirroring
  `RecurringInvoiceService.generateDue`/`DepreciationService.runForPeriod`
  — human-triggered, never scheduled (no job queue exists in this
  codebase). Unlike depreciation's single-step run, this is DRAFT-then-POST
  (like a bill/invoice): `create()` computes every `pay_run_lines` row for
  review and touches nothing else; `post()` is the one irreversible step
  that posts the combined payroll journal AND applies accrued leave to each
  employee's running balance. A DRAFT can be discarded with nothing to
  unwind; a POSTED run is immutable — a correction is a reversing journal
  plus a new, correct run, never an edit, the same discipline every other
  posted entry in this codebase follows.
  - Gross pay: salary pro-rated to the period, or hourly rate × approved
    timesheet hours pulled from `timesheet_entries` for the employee's
    linked `userId` (Phase 7 Slice 1's `TimesheetService` data, reused
    rather than re-entered — master spec §23's principle applied here) —
    or a manual hours override for an HOURLY employee with no linked login.
  - Superannuation: `SuperCalculations.calculateSuperGuarantee` tracks
    quarter-to-date OTE by summing this employee's prior **POSTED**
    `pay_run_lines` within the same standard calendar SG quarter (not a
    separately-maintained running total — avoids a second place that could
    drift out of sync with the pay run history itself), correctly applying
    the quarterly cap even when it's reached mid-period.
  - Leave: accrued per run per the NES formulas above, applied to
    `employees.annualLeaveBalanceHours`/`personalLeaveBalanceHours` (a
    perpetually-maintained running balance, same convention as
    `fixedAssets.accumulatedDepreciation`) only at `post()` time.
  - Journal (posted once per run, not per employee): debit Wages Expense
    (sum of gross) + debit Superannuation Expense (sum of SG); credit PAYG
    Withholding Payable + credit Superannuation Payable + credit Net Wages
    Payable. Net Wages Payable is a LIABILITY, not a bank account — this
    slice treats "posted" and "paid" as distinct for payroll, the same
    separation `PaymentRunService` already draws for supplier payments (no
    real bank-file payment generation exists in this codebase either); a
    separate manual payment settles the payable later.
- `StpReportService`: an STP Phase 2-SHAPED report (gross by income type,
  PAYG withheld, super liability) for a POSTED pay run only — proves the
  data model captures what real STP reporting needs without building the
  actual ATO transmission, the same "defer the real external integration"
  boundary as Basiq/Stripe elsewhere in this codebase. Labelled "NOT
  SUBMITTED TO THE ATO" prominently in the UI.
- Permissions: `employee:read`/`employee:manage`,
  `payrun:read`/`payrun:manage`/`payrun:post` (roles.ts). `PAYROLL_MANAGER`
  (a placeholder role since Phase 1) now holds the full set.
  ACCOUNTANT/BOOKKEEPER get read-only access (to reconcile the payroll
  journal's GL impact) but not manage/post — payroll management and its
  TFN/bank-detail sensitivity stay with PAYROLL_MANAGER/OWNER/ADMINISTRATOR.
- UI: `/payroll/employees` (list/new/detail/terminate),
  `/payroll/pay-runs` (list/new/detail with a payslip view/post/discard),
  and a per-pay-run STP-shaped report page. The withholding-approximation
  disclaimer is shown directly in the pay run creation and detail pages,
  not only in this doc.
- AI Controller exclusion (Phase 6) reconfirmed, not touched:
  `EXCLUDED_ACTION_TYPE_EXAMPLES` in `auto-execution-policy.ts` already
  listed `PAYROLL_ANY` before this slice: payroll remains structurally
  excluded from auto-execution at every autonomy level, and no payroll
  action was added to the whitelist mechanism or to any AI-controller tool.
- Tests: unit tests for bracket cumulative-base derivation (including the
  independent reproduction of this slice's hand-derived figures), PAYG
  withholding for known gross-pay amounts in both financial years, SG
  quarterly-cap behavior at/below/above the cap, and NES leave accrual for
  salaried and hourly employees; integration tests (real Postgres) for
  tax-rule effective-date resolution, a full salaried pay run (gross/PAYG/
  super/net/leave/GL all hand-verified), an hourly pay run sourcing hours
  from approved timesheets, quarter-to-date SG cap tracking across two
  consecutive pay runs for the same employee, duplicate-period rejection,
  TFN/bank-detail masking by role, and tenant isolation for
  `employees`/`pay_runs`/`pay_run_lines`.

**Explicitly deferred (document why, not a silent gap):**

- Real STP lodgment, HELP/study loan withholding, LITO effects on
  withholding, foreign-resident/working-holiday-maker/no-TFN withholding
  rate variations, Medicare Levy Surcharge, Payday Super's per-payday SG
  mechanics (see above), long service leave, termination pay/ETPs/
  redundancy, salary sacrifice/novated leases, workers' compensation, state
  payroll tax, leave loading, a leave-request/approval workflow (a running
  balance a pay run correctly accrues is this slice's deliverable; a
  request/approval UI is a reasonable future addition), and any
  scheduled/automatic pay run (on-demand only, no job queue exists).

## Phase 9 — Advanced Finance — **complete** (Slices 1-5)

### Slice 1 — Budgeting & Budget vs. Actual (complete, scoped per this slice's brief)

Master spec §36's budgeting core: baseline/revised-forecast/rolling-forecast
budgets, monthly line items by GL account (optionally scoped to a
dimension value), Budget vs. Actual reporting built on the exact same
`sumPostedActivityByAccount` aggregation every other financial statement
uses, an on-demand rolling-forecast "copy forward from date Y" action, and
a real Budget vs. Actual section in the Management Report Pack. This slice
deliberately stays inside the budgeting core — see "Explicitly deferred"
below for everything else Phase 9's one-line description names.

**What's built:**

- `budgets`/`budget_lines` (`src/db/schema.ts`): `budgets` is org-scoped —
  name, `type` (`BASELINE`/`REVISED_FORECAST`/`ROLLING_FORECAST`, master
  spec §36's three version concepts), `status`
  (`DRAFT`/`ACTIVE`/`ARCHIVED`), and a fixed `periodStart`–`periodEnd`
  range (a fiscal year or any custom range). `budget_lines` is one row per
  (account, optional dimension value, calendar month) — monthly
  granularity, the simplest shape to report against and the norm master
  spec §36 implies ("by GL account, department, location, project, entity,
  month, quarter, year"). A dimension-scoped line reuses Phase 5 Slice 2's
  `dimension_values` table directly rather than a parallel tagging
  mechanism. Neither table has a `journalEntryId` anywhere, and
  `BudgetService` never calls `PostingService` — a budget is planning
  data, never a ledger posting.
  - **No DB-level uniqueness constraint** on (budget, account, dimension
    value, month): `dimensionValueId` is nullable, and Postgres treats
    every NULL as distinct in a unique index, so a naive unique index
    would not actually stop two rows for "this account, no dimension, this
    month." `BudgetService.setAccountLines` enforces "one row per account/
    dimension/month" itself: every bulk-entry save deletes the existing
    rows for that exact (budget, account, dimension) combination across
    the submitted months and re-inserts the new set in the same
    transaction — structurally never a duplicate even without a DB
    constraint. See docs/database.md.
  - **Only-one-ACTIVE-baseline is enforced structurally, but only for
    `BASELINE`**: `BudgetService.activate` refuses to activate a BASELINE
    budget whose period overlaps another org's already-ACTIVE BASELINE
    budget — ambiguity about "the" baseline is the one case worth a real
    database-backed rule. `REVISED_FORECAST`/`ROLLING_FORECAST` budgets are
    deliberately exempt — master spec §36 expects a revised/rolling
    forecast to coexist alongside (and be reportable against individually
    from) the baseline it was derived from, so restricting those too would
    block the exact workflow this slice builds.
- `BudgetService` (`src/domain/budgeting/budget-service.ts`): create/
  list/get a budget; `setAccountLines` is the bulk-entry upsert — one
  account's (optionally dimension-scoped) whole year of monthly figures in
  one call, not one API call per cell, per this slice's brief; `activate`/
  `archive` for the DRAFT→ACTIVE→ARCHIVED lifecycle (lines are only
  editable while DRAFT — an ACTIVE budget a report or the Management Pack
  is already reading from can never change under a reader without a
  deliberate new revision); `createRollingForecast`.
- **Rolling forecast** (`BudgetService.createRollingForecast` +
  `src/domain/budgeting/rolling-forecast.ts`'s
  `partitionLinesForRollingForecast`): on-demand and user-triggered only —
  "create a rolling forecast from budget X, carrying forward periods after
  date Y" — never a scheduled/automatic rolling window, the same job-queue
  gap every other recurring process in this codebase documents (no job
  queue exists here at all). Copies a source budget's lines into a new
  DRAFT `ROLLING_FORECAST` budget: every line on/before the cutoff is
  copied through exactly unchanged (history preserved), every line after
  it is carried forward as a starting point the user then edits via the
  same `setAccountLines` bulk-entry form — the source budget itself is
  never modified.
- **Budget vs. Actual** (`src/domain/budgeting/budget-variance-
  calculations.ts` + `budget-variance-service.ts`'s `BudgetVarianceService`):
  built alongside `ReportingService`, not inside it, but reusing its exact
  building blocks — the actual side is `sumPostedActivityByAccount`, the
  identical shared aggregation every financial statement uses (no parallel
  GL query path), and both sides are normal-balance-signed via the same
  `normalSignedBalance` helper `financial-statements.ts` already exports.
  Scoped to REVENUE/EXPENSE accounts, the same P&L shape
  `buildProfitAndLoss` itself is scoped to. **Reconciles correctly** per
  this slice's non-negotiable: the report is the UNION of every account
  that appears on either side — a budget line with zero actual activity
  still gets a full row (not a missing one), and actual activity with no
  budget line still gets a row, flagged via `unbudgetedActivity` rather
  than silently dropped. Variance is `actual − budget` in both $ and %,
  with `variancePercent` explicitly `null` (never a divide-by-zero or a
  misleadingly large number) when the budget side is exactly zero.
- **Management Report Pack** (`src/domain/reporting/management-pack-
  service.ts`): a new `budgetVsActual` section, master spec §35's "Budget
  vs Actual" as a standard pack section, now that budgets exist. Uses the
  org's current ACTIVE BASELINE budget covering the pack's as-of date,
  found via `BudgetService.findActiveBaseline`; `null` (never an error,
  never fabricated) when no such budget exists, and the page below renders
  that as a clean "no budget yet" card rather than hiding the gap. The AI
  commentary step is handed the same already-computed Budget vs. Actual
  totals as every other section — never raw ledger data, never asked to
  calculate anything itself.
- Permissions: `budget:read`/`budget:manage` (`roles.ts`).
  ACCOUNTANT/BOOKKEEPER get full manage access (budgeting sits with the
  same roles that already own financial reporting and the chart of
  accounts); MANAGER/READ_ONLY get read-only; ACCOUNTS_RECEIVABLE/
  ACCOUNTS_PAYABLE/PAYROLL_MANAGER/EMPLOYEE get neither, consistent with
  their existing narrower scopes.
- UI: `/budgets` (list with status pills), `/budgets/new`, `/budgets/
  [budgetId]` (detail — monthly-lines table grouped by account/dimension,
  the bulk "enter a whole account's year" form, activate/archive, link to
  create a rolling forecast), `/budgets/[budgetId]/rolling-forecast`
  (create form), and `/accounting/reports/budget-vs-actual` (budget +
  period picker, the Budget/Actual/Variance $/% table, an "unbudgeted"
  flag per line). The Management Pack page gained a fourth section
  rendering `budgetVsActual` or a clean "no budget yet" card. A new
  top-level `Budgets` nav section was added, gated on `budget:read`.
- Tests: unit (`calculateLineVariance`'s $ and % variance including the
  zero-budget/zero-actual/both-zero edge cases;
  `partitionLinesForRollingForecast`'s past/future split, including a
  cutoff exactly on a line's `periodEnd` and the straddling-line rejection);
  integration against the real test database (bulk-entry line creation and
  activation; refusing a second overlapping ACTIVE baseline while allowing
  a REVISED_FORECAST to coexist; Budget vs. Actual reconciling real posted
  invoices/bills against real budget lines including the zero-budget and
  zero-actual cases; a rolling forecast correctly carrying forward
  unedited future periods while preserving past-period figures and never
  touching the source budget; the Management Pack including a correct
  section when an ACTIVE baseline exists and omitting it cleanly when none
  does; a tenant-isolation case for `budgets`/`budget_lines`). The full
  existing suite passes alongside these — 676 tests total after this
  slice, up from 653.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all
  pass. Smoke-tested for real against a local Postgres (a script
  exercising the real services, not just the test suite): created a
  budget, entered a revenue line ($10,000) and an expense line ($3,000)
  for January 2026, activated it, posted a real $12,000 revenue journal
  and a real $2,500 expense journal, and confirmed Budget vs. Actual by
  hand: revenue variance exactly $2,000/20.00% and expense variance
  exactly −$500/−16.67% (both independently recomputed by hand from the
  posted figures). Created a rolling forecast with a carry-forward cutoff
  after the only month of data and confirmed it copied that month through
  as "past," unchanged.

**Explicitly deferred to later Phase 9 slices (document why):**

- **Scenario modelling** (master spec §37) and **cash flow
  intelligence/forecasting** (master spec §38): originally deferred here as
  distinct features from entering and reporting a single committed budget;
  both are built in Slice 2 below.
- **Month-end close workspace and period-lock override workflow**
  (master spec §40/41) — **built in Slice 3 below**: ties into the existing but still-manual
  period-lock mechanism from Phase 1 (`fiscal_periods`/
  `fiscal_period:manage`) — a close checklist, sign-off trail, and an
  override-with-reason flow are a distinct, close-specific surface, not
  something to bolt onto budgeting.
- **Multi-entity consolidation** (master spec §30): needs multiple real
  linked organizations and elimination-entry logic — a big feature with
  no dependency on budgets existing first.
- **Accountant practice management and workpapers** (master spec §42/43):
  a distinct, practice-facing surface (client lists, engagement tracking,
  workpaper templates) orthogonal to any single organization's budgeting.
- A budget against non-REVENUE/EXPENSE accounts (e.g. a capex budget
  against a fixed-asset account) is still fully storable and queryable via
  `budget_lines` directly — the schema has no type restriction — but the
  Budget vs. Actual *report* only surfaces REVENUE/EXPENSE rows, matching
  the P&L shape this slice's brief asks for explicitly. A balance-sheet-
  shaped variant is a reasonable future addition, not attempted here.
- Any scheduled/automatic rolling-window advance (e.g. "roll forward every
  month automatically") — `createRollingForecast` is on-demand only, see
  above; no job queue exists in this codebase for a true scheduled version.

### Slice 2 — Cash Flow Intelligence & Scenario Modelling (complete, scoped per this slice's brief)

Master spec §38's cash flow forecast and §37's scenario modelling. Both are
**read-only analysis**: no `PostingService` call and no write to any
financial table exists anywhere in `src/domain/forecasting/`. The single
most important design requirement of §38 — "distinguish known commitments
from statistical projections" — is expressed in the data model, not just in
labels.

**What's built:**

- **KNOWN vs STATISTICAL is structural** (`src/domain/forecasting/types.ts`).
  A forecast line is one of two different TYPES discriminated by `kind`:
  `KnownForecastLine` (carries the `timing` that justifies its date and the
  source document's own `statedDate`) and `StatisticalForecastLine`
  (carries the explicit `basis` it was derived from, and optionally
  `replacesLineId`, the known line it supersedes in the second series). The
  forecast returns TWO series — `knownOnly` and `withStatistical` — and there
  is no field anywhere that sums both kinds into one number. A statistical
  twin carries the SAME cash as the known line it replaces, only on a
  different expected date, so the two series never double count.
- `CashForecastService.generate` (`cash-forecast-service.ts`; pure maths in
  `forecast-calculations.ts`): a day-by-day projected balance for 7D / 30D /
  60D / 90D / 12M from "today" (an `asOfDate` for tests). **Granularity**:
  daily up to 90 days; weekly (end-of-week, plus day 0 and the final day) for
  12 months — day-level resolution a year out is false precision (the
  statistical shifts are themselves only whole-day estimates) and 365 points
  per series is noise on a page. The series are ALWAYS computed daily
  underneath, so the low point and the first-breach date are day-exact
  regardless of display granularity.
  - **Opening cash** is `loadCashPosition` (`reporting/cash-position.ts`),
    extracted verbatim from `DailyFinanceBriefService` (a bank account IS its
    linked GL account's balance) and now shared by the brief and the
    forecast — one definition of "cash on hand".
  - **KNOWN lines**: open (approved/sent/part-paid) customer invoices at their
    stated due date (outstanding balance via the Aged Receivables service);
    open approved supplier bills at due date; bills inside an APPROVED
    payment run at the run's payment date (emitted ONCE — never as a bill and
    again as a run; a run paying part of a bill splits it); active recurring
    invoice/bill templates' upcoming occurrences, honouring `endDate`/
    `maxOccurrences` and walking forward with the same `advanceRecurringDate`
    the generator uses (amounts recomputed from current tax rates; cash date
    is issue date + the platform's fixed 30-day default terms, which both
    generators now export); posted payroll liabilities (see caveat below).
    **Overdue** is handled prudently in each direction: an overdue
    RECEIVABLE is a known amount whose receipt date no document states, so it
    is undated and off the known timeline (`OVERDUE_RECEIPT_UNDATED`); an
    overdue PAYABLE is assumed due today (`OVERDUE_ASSUMED_DUE_NOW`).
  - **STATISTICAL lines**: (1) shift an open (or recurring-template) invoice's
    expected receipt by that customer's historical average lateness — the
    exact `loadCustomerPaymentHistory` Phase 3 Slice 2's collection priority
    already computes from settled invoices (now exported, and also returning
    the sample size so the UI can flag a thin history); an early payer shifts
    earlier, never before today; a customer with NO settled history gets NO
    statistical line (nothing invented). (2) Repeat the last POSTED pay run's
    net wages at its pay frequency across the horizon (headcount/hours can
    change, so it is never known).
  - **What "statistical" means here, plainly**: simple, explainable averages —
    a customer's own average days late over their own paid invoices; a repeat
    of the last pay run. It is NOT a forecasting model: no machine learning,
    no seasonality, no confidence intervals. That is a deliberate, honest
    scope choice, and every statistical line shows the average and the number
    of invoices behind it. An optional trailing-average "not-yet-invoiced
    revenue/expense" projection was deliberately NOT built: done naively it
    double counts open invoices, bills and recurring templates already in the
    known series, and doing it honestly needs a cash-basis model this slice
    does not have.
  - **Payroll caveat (do not paper over)**: posted pay runs credit net-wages,
    PAYG-withholding and super payables. The AMOUNT owed is known (the
    ledger balance of those accounts), but this codebase has no verified
    due-date rule — the PAYG remittance schedule is not modelled, FY2026-27
    Payday Super mechanics are explicitly unresolved (see Phase 8), and a
    net-wages payment is a separate manual action. So each is a KNOWN-amount
    line with `timing: "UNVERIFIED"` and NO date: it is never placed on a
    timeline at an invented due date. The result reports these as
    `unscheduledKnown` and a prudence floor
    (`lowPointIfUnscheduledOutflowsPaidNow` — the known-only low point if
    every undated outflow were paid today; a bound, not a prediction).
  - **Payroll access sensitivity**: payroll-derived lines are gated on
    `payrun:read` (`roleHasPermission`), mirroring the Pay Runs page. An
    actor without it (MANAGER, READ_ONLY) gets a COMPLETE forecast with
    payroll lines omitted (`payrollOmitted: true`, plus a caveat) — never an
    error and never a leak; this holds on the page and through the AI tool,
    and the unscheduled-amount text is built from what the forecast actually
    contains so it never hints at omitted payroll either (proved with a real
    restricted-role actor in `cash-forecast.test.ts` and
    `cash-forecast-ai.test.ts`).
  - **Low-cash warning**: a user-configurable org-level threshold
    (`cash_forecast_settings`, one row per org, default 0, audited via
    `ForecastSettingsService`, needs `forecast:manage`) evaluated on EACH
    series independently with the date it first dips below and "in N days"
    (master spec §6's "Cash Warning" UX). The message always names which
    series it is about; a breach only on the statistical series is shown as
    estimate-driven.
  - **Payment-run state, honestly**: `PaymentRunService.approve` approves AND
    pays in one step in this codebase (no bank-file integration exists), so
    an APPROVED-but-unpaid run is never persisted by the current services.
    The forecast handles that state correctly anyway (it re-dates the bill)
    so it is right the moment a real payment rail introduces it, and treats
    AWAITING_APPROVAL runs as proposals — the bill stays at its own due date
    and only gains a note. The `APPROVED` branch is tested by forcing that
    status directly.
  - **DB discipline**: calls are deliberately sequential (cash position 2
    checkouts, receivables 2, payables 1, pay-run summaries 1, plus ONE own
    transaction for payment runs/templates/tax rates/threshold); nothing
    fans out in parallel. The Daily Finance Brief hands the forecast the
    cash position/receivables/payables it already loaded, so the headline
    adds only the forecast's own reads.
- `ScenarioService` (`scenario-service.ts`; pure maths in
  `scenario-calculations.ts`; zod schemas in `scenario-parameters.ts`): the
  closed set of three master-spec §37 types, each with a typed parameter set
  (a `scenario_type` enum — a new type is a deliberate code change, not a
  free-form modeller). Saved scenarios are saved QUERIES (name + type +
  validated parameters), re-run against fresh data every time (proved by a
  freshness test) and re-validated on every read; `scenarios` stores no
  result.
  - **HIRE_EMPLOYEE**: salary, on-cost % (REQUIRED — no hardcoded AU on-cost;
    the form PRE-FILLS the verified SG rate from Phase 8's rule engine,
    `suggestedHireOnCost`, as an editable suggestion, null outside seeded
    rule sets), start date (pro-rated in the first month), optional
    incremental monthly revenue (default 0) with a linear ramp.
    Best/Worst = revenue realised at 125% / 0% of the stated expectation
    (editable). Outputs: P&L delta, run-rate cash, runway, break-even
    (monthly and cumulative-payback month), fully loaded monthly cost.
  - **PRICE_CHANGE**: % change over ALL revenue, selected customers,
    products, or revenue accounts (the in-scope share of trailing-12-month
    invoiced revenue is applied to each baseline month). **Elasticity is NOT
    estimated**: the volume change per case is an explicit assumption
    (default best 0 / expected 0 / worst −5%), because inferring a price
    response from a small business's history is confounded and
    underdetermined and a fabricated estimate is worse than a stated
    assumption. Cost on lost volume is derived from the scope's own
    tracked-inventory cost of sales (0 if none), overridable.
  - **LOSE_CUSTOMER**: defaults to the largest customer by trailing-12-month
    invoiced revenue (real data). Revenue effect from their share; margin
    effect uses cost of sales actually attributable to that customer
    (tracked-inventory SALE movements linked to their invoice lines) — when
    none exists the result says it is REVENUE-ONLY, and an avoided-cost %
    override is available. Best = 50% of the lost revenue replaced after a
    3-month lag; Worst = their currently open receivables collected 2 months
    late (a pure cash-timing shift) — all editable, none predictions.
  - **Baseline** is explicit: the average of the last N (default 3) FULL
    calendar months of posted activity held flat, or an ACTIVE baseline
    budget (Slice 1); with no active budget it fails with
    `ScenarioBaselineUnavailableError` rather than inventing one. Cash is a
    RUN-RATE path (opening cash + cumulative monthly net profit) over the next
    12 full calendar months — explicitly NOT a working-capital model; the
    90-day cash forecast is shown alongside as near-term context.
  - Every case lists the assumptions it applied; the UI and AI commentary
    describe Best/Expected/Worst as assumptions, never predictions.
- AI (strictly optional, strictly the established pattern):
  `ForecastCommentaryService` — optional commentary over ALREADY-COMPUTED
  figures only (same pattern as the management pack/Daily Brief; `null`
  without an API key or on any failure; KNOWN and STATISTICAL kept under
  separate labels; opt-in per page load via `?commentary=1` so no model call
  runs on every render). And a read-only `cash_forecast` tool on the AI
  Financial Controller (`controller-tools.ts`, `forecast:read`,
  permission-checked and cited like every other tool; also offered to the FP&A
  specialist) whose result keeps KNOWN COMMITMENTS ONLY and INCLUDING
  STATISTICAL PROJECTIONS under separate headings with the low-cash date. No
  scenario-creating tool exists (that would need Phase 6's
  proposal/confirmation machinery) — a test asserts no tool name mentions
  scenarios; scenarios are created by humans in the UI.
- Daily Finance Brief gains a `cashForecast` headline (the 90-day low point on
  each series) and folds the warning into its callouts — never fatal to the
  brief.
- Permissions: `forecast:read`/`forecast:manage`, `scenario:read`/
  `scenario:manage`. `forecast:read` goes only to roles that already hold
  every underlying read permission (OWNER/ADMIN, ACCOUNTANT, BOOKKEEPER,
  MANAGER, READ_ONLY) — a unit test over `ROLE_PERMISSIONS` pins that
  invariant so the single `forecast:read` check cannot widen access;
  ACCOUNTANT/BOOKKEEPER also manage (mirroring budgets). Every mutation
  (scenario create/update/delete, threshold change) is audited.
- Schema: `scenarios` and `cash_forecast_settings` (migrations 0033/0034),
  both org-scoped with RLS enabled + FORCEd + policy + `mm_app` grant —
  tenant-isolation audit now **64 of 70** tables.
- UI: `/forecasting/cash-flow` (horizon selector; two-series chart — solid
  vs dashed, differentiated by style AND colour, with the threshold line and an
  accessible data table; low-cash callout; known-vs-statistical line tables,
  every line linked to its source document with its timing/basis; the
  unscheduled-known box; threshold form; limitations list) and
  `/forecasting/scenarios` (list, create-by-type forms stating every default,
  edit, and a results view with Baseline | Best | Expected | Worst side by
  side, the assumptions each case used, the derived inputs, month-by-month
  tables, and the 90-day context). New `Forecasting` nav section.
- Tests: unit (line classification, lateness shifting incl. early payers and
  clamping, template occurrence generation, series balances across horizons
  with hand-computed numbers, first-breach detection, each scenario type's
  Best/Expected/Worst against hand-computed inputs, zod rejection of
  malformed/missing parameters for every type, the permission-matrix
  invariant, form<->parameter round-trips, the chart); integration against the
  real database (a seeded mix — bank balance, an average-12-days-late
  customer with settled history, overdue/not-yet-due invoices, bills, an
  approved payment run, recurring templates, a posted pay run — with the
  known-only series, the including-statistical series, the low points, the
  first-breach date and every scenario type verified against hand
  calculation; freshness; payroll omission for a role lacking `payrun:read`;
  the AI tool's permission refusal with a real restricted-role actor and its
  end-to-end tool loop with a mocked SDK; commentary; budget baselines;
  ledger-untouched checks; audit entries; tenant isolation). 825 tests total
  after this slice, up from 676.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all
  pass. The real Anthropic API is only ever exercised through a mocked SDK,
  as with every AI feature here; the UI pages were compiled by `next build`
  and the chart component rendered to markup in a unit test, but the pages were
  not driven in a real browser session in this slice.

**Explicitly deferred (document why):**

- Month-end close workspace / period-lock override workflow (built in Slice 3
  below), multi-entity consolidation, accountant practice management/workpapers:
  separate Phase 9 slices (see Slice 1's list), unrelated to forecasting.
- Scenario types beyond the three named in §37 and a free-form scenario
  builder: the closed, typed set is the point — each type needs its own
  honest, explainable maths.
- Machine-learned or seasonally-adjusted forecasting: "statistical" is
  deliberately simple averages (above). A real model needs far more history
  and validation than a small-business ledger usually has, and a confident
  but unjustified number is exactly what §38's known-vs-statistical split
  exists to prevent.
- A trailing-average projection of not-yet-invoiced revenue/recurring
  expense (double-counting risk, see above) and GST/BAS liabilities (no
  tax-filing domain; due dates unverified), unapplied supplier credits and
  approved-but-unreimbursed expense claims in the forecast.
- PAYG/super remittance DATES (unverified — kept as known-amount, undated
  lines) and any projected PAYG/super outflows.
- Multi-currency forecasting: base currency only, following the codebase's
  convention (every amount here is assumed to be in the organization's base
  currency).
- Scheduled/emailed forecast alerts: no job queue exists; the warning is
  shown on demand on the page, in the Daily Brief and via the AI tool.
- Comparing two saved scenarios against each other: the results view compares
  one scenario's three cases against the baseline; a cross-scenario compare
  is a reasonable follow-up.

## Phase 9 Slice 3 — Month-End Close workspace and period-lock override workflow — complete

Master spec §40 (Month-End Close), §41 (Period Locking) and §77 (human override
/ audit trail). This closes the item the roadmap has carried since Phase 1 —
"period-lock override workflow UI — reject path enforced, override workflow
deferred to Phase 9 (Close)". Design detail is in `docs/accounting-engine.md`
§15; the security view in `docs/security.md` §11; the AI surface in
`docs/ai-agents.md` §0g.

**Built**

- **Lock levels on the existing period concept.** `fiscal_periods.status`
  now carries `OPEN < SOFT_LOCKED < ADVISOR_LOCKED < TAX_LOCKED < HARD_LOCKED`
  (one concept, no parallel flag; severity order in `LOCK_RANK`). The pure
  `evaluatePosting`/`evaluateLockChange` hold the whole permission matrix.
  `PostingService` still rejects **inside the same transaction as the insert**,
  with one query, before anything is written — a test proves a rejected post
  leaves no journal entry, lines, audit entry or history row, for every level
  x posting role. Overlapping periods: the most restrictive governs. The period
  end date now covers its whole UTC day (a timestamped posting on the last day
  could previously slip past a lock).
- **Inline override (SOFT) and advisor posting.** `PostOptions
  .lockOverrideReason` on `postJournal`/`postDraft`/`reverseEntry` (and passed
  through invoice, bill and supplier-credit approve-and-post), validated against
  the actor's server-side role. The journal records the level and reason; the
  append-only history gets a `POSTING_OVERRIDE` row; `audit_logs` gets
  `journal.posted_under_lock`. UI: manual journal, invoice, bill and supplier
  credit show "Post anyway — reason required" for an authorised user and a clear
  consequence/who-can-reopen message otherwise (a journal blocked by a lock is
  kept as a draft, never lost).
- **Reopen workflow.** `period:reopen` (soft/advisor) or `period:reopen_hard`
  (OWNER/ADMINISTRATOR only, for TAX/HARD), a mandatory reason (>= 10 chars),
  and for TAX_LOCKED a typed "may invalidate a lodgement" acknowledgement.
  Recorded in the append-only `period_lock_events` (INSERT/SELECT-only for
  `mm_app`, verified with the real restricted role) and in `audit_logs`; a
  reopen starts a fresh close cycle.
- **Month-end close workspace** (`/accounting/close`, `/accounting/close/[period]`):
  the month list (including months that exist only implicitly) with lock
  level, close status, live % for the focus month and the at-close % for closed
  ones; the period page is the workspace — progress bar with the formula stated,
  "what remains", checklist by category with live status and drill-down links,
  manual sign-offs (named + timestamped, labelled as a person's attestation, never
  system verification), close / raise-lock / reopen forms with reasons, close
  history by cycle, and the lock-event timeline.
- **Checklist engine (live, never stored).** Automatic: bank reconciliation per
  account, draft invoices/bills/credit notes/journals, submitted expense claims,
  draft pay runs (omitted without `payrun:read`), depreciation run, fixed-asset
  register and inventory valuation vs the ledger (BLOCKING), trial balance and
  Balance Sheet equation (BLOCKING), suspense/clearing accounts (N/A when the org
  has none — the platform creates none), earlier-period sequencing (a warning).
  Manual sign-offs: accruals, prepayments, tax review, P&L review, Balance Sheet
  review, budget variance, foreign exchange (N/A without foreign lines),
  intercompany (always N/A). Closing is refused with a typed error listing
  BLOCKING items; outstanding items need an explicit acknowledgement; the
  checklist snapshot is stored with the close and in the audit entry. Default
  lock on close: SOFT_LOCKED (justified in the accounting-engine doc).
- **Migration of the old model.** Legacy `SOFT_LOCKED` (which blocked everyone)
  became `HARD_LOCKED` so no lock is loosened; legacy `HARD_LOCKED` and `OPEN`
  are unchanged; each carried-over lock has a `MIGRATED` history row. Verified by
  a test that runs the migration SQL on legacy-shaped rows, and it ran on the real
  dev database's seeded FY2026 lock.
- **AI (read-only).** A `close_status` Financial Controller tool
  (`close_checklist:read`, citation to the workspace, payroll omitted without
  `payrun:read`) and optional "what remains" commentary over the computed
  checklist (omitted without an API key). **No write path exists:** tests assert
  no tool/permission/auto-execution action can close, lock, reopen or sign off,
  and that an `AI`/`SYSTEM` actor with an OWNER role is refused.
- Three new tables (`period_closes`, `close_signoffs`, `period_lock_events`),
  all RLS-enabled + FORCEd + policy + scoped grants; the tenant-isolation audit is
  now **67 of 74** tables.
- Tests: unit (lock ordering, the full level x role x reason posting matrix, the
  lock-change/reopen validation incl. TAX acknowledgement, each check's status
  logic, the progress formula incl. N/A and manual items, period references);
  integration against the real database (every level x role posting outcome with
  nothing persisted on rejection; soft-lock override; hard lock rejects the
  owner; draft/reversal/overlap/end-of-day; invoice and bill approve-and-post
  under a lock; close refused for BLOCKING items and for missing acknowledgement;
  snapshot and audit; reopen permissions/reason/TAX acknowledgement; re-close
  after reopen as a new cycle; each automatic check flipping when the data is
  fixed; manual sign-offs; N/A handling; payroll omission; the history table's
  UPDATE/DELETE/TRUNCATE denied to `mm_app`; tenant isolation for every new
  table; the migration mapping; the AI tool's refusal with a real restricted-role
  actor, its end-to-end loop with a mocked model, and the exclusion tests).
- `npm run typecheck`, `npm run lint`, `npm test` (1003 tests, up from 900; the 900
  existing tests pass unmodified) and `npm run build` all pass. A smoke test
  against `next start` with real NextAuth logins drove the whole flow over HTTP
  with the real server actions (see "Verified for real" below).

**Verified for real vs not**

- Real: a deliberately unreconciled bank transaction and a draft invoice showed
  up in the checklist (progress 50%), a sign-off recorded the signer's name,
  fixing the bank item and invoice in the ledger raised the figure (71%),
  signing off the remaining items reached 100%; closing without the
  acknowledgement was refused by the server; closing at SOFT_LOCKED worked;
  a bookkeeper's post into the period was rejected with the explained message and
  no override offered; the owner was offered "Post anyway", a too-short reason was
  refused, and a valid reason posted the journal (and, separately, an invoice)
  and showed the override on the entry; reopen with a short reason was refused, a
  bookkeeper saw no reopen control, and the owner's reopen with a reason was
  recorded; the database showed matching `period_lock_events`, `audit_logs` and
  `period_closes` (cycle 1 CLOSED with a 22-item snapshot, cycle 2 IN_PROGRESS).
- Not driven: a real browser (the pages were exercised by HTTP form submission
  with the real server actions, and compiled by `next build`), and the real
  Anthropic API (only ever exercised via a mocked SDK).

**Deferred (document why)**

- **Dashboard "Month close: N% complete" card.** Skipped: the percentage needs
  the full live checklist (~15 queries including three reporting services), which
  would add heavy queries to the home page, against the DB-connection rule that a
  production incident was fixed for. The close page and the sidebar entry are
  the surface; the list page computes live progress for the single focus month
  only.
- **Tax lodgement integration.** There is none: TAX_LOCKED is a manual lock the
  user applies and labels.
- **Inline override on other posting paths** (payments, pay runs, depreciation,
  expense claims, bank categorisation): rejected by a lock with the explained
  message; the override is wired into the human flows most likely to hit a locked
  period (manual journals, invoice/bill/credit approve-and-post). Adding the
  option to another path is one pass-through parameter.
- **Request/approve override as a two-person workflow** and **notifications**:
  the override is a single authorised, reasoned, audited action; there is no
  messaging/approval-inbox infrastructure for a request flow.
- **Per-organization role customisation** of the new permissions: the static
  role matrix is used, like every prior slice.
- **Unrealised FX revaluation and intercompany**: surfaced as manual items; the
  platform does not automate either.
- **Scheduled/automatic close or reminders**: no job queue exists.
- **Year-end close (closing entries / retained-earnings roll-forward) and a
  configurable fiscal-year start**: still the calendar-year assumption in
  `docs/accounting-engine.md` §8b. The lock model works on any period range
  (a financial year is just a period), but defining fiscal-year semantics for
  retained earnings is a separate, invasive change.

**Remaining Phase 9 items:** **accountant practice management and workpapers**
(§42/43) — a separate later slice. (Multi-entity consolidation, §30, was built
in Slice 4 below.)

## Phase 9 Slice 4 — Multi-entity accounting and consolidation — complete

Master spec §30: switch company instantly, consolidated P&L / balance sheet /
cash, intercompany accounts and eliminations, consolidation adjustments —
"never allow data from unauthorised entities to leak through AI retrieval".
Design detail: `docs/accounting-engine.md` §16 (mapping, eliminations, balance-
sheet proof, currency), `docs/security.md` §12 (why RLS is untouched, the group
tables' access model, the AI no-leak guarantee), `docs/database.md` §2p.

**The central design decision: consolidation is computed in the application
layer, one entity at a time.** There is no multi-organization session variable,
no bypass policy, no privileged connection, no SECURITY DEFINER anywhere.
`ConsolidationService` loops over the group's included entities **strictly
sequentially** (plain `for`, never `Promise.all`; one pooled connection at a
time), builds an `Actor` from the user's **real membership role in that entity**,
calls the existing `ReportingService` / `loadCashPosition` inside that entity's
own `withTenant` transaction (the service enforces `financial_report:read`
itself), and aggregates the already-authorised results in memory with the pure
engine in `src/domain/consolidation/`. An entity the user is not a member of is
never touched; one where the role lacks the permission is excluded; the result
says "N entities excluded — no access" and names nothing it should not.
Groups are bounded at 10 entities.

**What's built**
- **Entity groups** — user-owned (`entity_groups`, `entity_group_members`,
  `entity_group_accounts`, `entity_group_account_mappings`,
  `entity_group_intercompany_accounts`, `entity_group_adjustments` +
  `_lines`, `entity_group_audit_logs`; migrations `0038`, `0039`). Eight
  **user-scoped** tables protected by FORCEd RLS keyed on
  `owner_user_id = app.current_user_id`, set per transaction by the new narrow
  wrapper `withUserScope` (`src/db/user-scope.ts`) — the exact sibling of
  `withTenant`. An INSERT policy also requires the owner to be an *active
  member* of the organization being added, so even application bugs cannot pull
  in an organization the user is not in. Adding an entity additionally needs
  `consolidation:manage` **in that entity** (new permission; Owner,
  Administrator, Accountant) — a READ_ONLY member cannot add it.
- **Isolation audit extended** (`src/db/isolation-audit.ts`, extracted from
  `migrate.ts` so it is unit-testable): classifies tables as organization-scoped
  (`organization_id`) or user-scoped (`owner_user_id`), requires FORCEd RLS and a
  policy keyed on *that scope's single variable only*, forbids a policy mixing
  the two, and flags any multi-valued predicate (`ANY(...)`, `string_to_array`,
  …) against a session setting on any table. The group tables deliberately have
  no `organization_id` column (`member_organization_id`) so they cannot be
  mistaken for tenant tables.
- **Entity switcher** — none existed beyond the post-login chooser. The
  `[orgSlug]` layout already loaded the user's membership; one
  `listMembershipsForUser` query now feeds a topbar dropdown
  (`EntitySwitcher`, hidden with a single membership) plus links to "Entity
  groups". Switching is a plain link: the target organization resolves the
  user's role there for itself.
- **Consolidated Profit & Loss, Balance Sheet, cash position** — `/app/groups/[id]/reports/*`.
  Per-entity columns, a Combined column, an "Elim. & adj." column and the
  Consolidated column; each line expands to the entity accounts it came from,
  linking to *that entity's* account-transactions page (which re-checks
  permission itself). The Balance Sheet check (Assets = Liabilities + Equity) is
  evaluated for every column — each entity, combined, adjustments, consolidated.
  Reuses `ReportingService` output; no ledger logic is re-derived.
- **Account mapping** — a per-group chart of accounts; the first entity added
  seeds it. An entity account reports under the group account with the **same
  type and code**, unless the user maps it elsewhere (type must match); no match
  → an explicit **Unmapped** bucket that is still counted.
- **Intercompany & eliminations** — designate an entity account as
  receivable / payable / loan receivable / loan payable / revenue / expense with
  a named counterparty entity (also a group member). Matched amounts are
  eliminated **in memory**; only `min(creditor, debtor)` is eliminated, so
  sheets stay exactly balanced while a mismatch, one-sided balance or
  unavailable counterparty is listed in the reconciliation (amount in each
  entity's books, difference) and left in the totals — never forced to zero.
- **Manual consolidation adjustments** — group-level, balanced, append-only
  (`mm_app`: SELECT + INSERT), reversed only by a new mirror row, with a mandatory
  reason; never `journal_entries` of any entity (proved: entity ledgers, trial
  balances and audit logs byte-identical before/after).
- **Audit** — every group mutation writes the group-level audit log in the same
  transaction (with the user's real role in the entity where a permission was
  checked). Adding/removing an entity also leaves an informational note in that
  entity's *own* audit log containing only the opaque group id and the actor —
  never the group's name, its other entities or any figure.
- **AI** — read-only `consolidated_report` Controller tool (P&L / Balance Sheet /
  cash for one of the user's groups) using the same per-entity checks; no write
  tool; the autonomy/auto-execution exclusions are untouched. Test with real
  restricted-role actors proves nothing from an unauthorised entity reaches the
  model or the answer path.
- **Currency** — single-base-currency groups only; mixed currencies are refused
  with "These entities have different base currencies: AUD, NZD — currency
  translation is not yet supported". There is no tested exchange-rate mechanism
  in the codebase (`exchange_rates` is an unused table), and inventing rates is
  not acceptable. The refusal considers only entities the user can access, so it
  can never reveal an unauthorised entity's currency.
- Tests: engine unit tests (mapping incl. unmapped bucket, matched / mismatched /
  one-sided / unavailable eliminations, exact decimals, adjustments, balance
  after eliminations, refusal message, cap), a structural boundary test
  (no raw `db`/`pg`/session variables/`Promise.all` in consolidation; the
  migration adds no bypass), isolation-audit unit + real-database tests, and
  integration tests with a user who is OWNER in A, ACCOUNTANT in B, READ_ONLY in
  C and not a member of D (hand-verified numbers; exclusions; add rules;
  other-user isolation at service and database level; append-only history;
  sequential instrumentation; platform admin has no special access; AI no-leak).

**Verification.** `npm run typecheck`, `npm run lint`, the full suite (1088 tests,
up from 1003) and a production build pass. Smoke-tested for real (HTTP against
`next start`, real NextAuth credentials login, the real server actions): one user
in two organizations → the switcher lists both → create a group, add both
entities, designate the intercompany loan on each side → the consolidated Balance
Sheet balances with the 10,000 loan eliminated, drill-down links point at each
entity's own pages, P&L and cash render → the user's role in one entity lowered to
EMPLOYEE, then the membership removed → that entity drops out of the next view
with "1 entity excluded — no access" (named only while the user still belongs to
it), the loan is reported as "counterparty unavailable", and the entity's own
pages 404. The Anthropic API itself is only exercised through a mocked SDK.

**Dashboard widget — not built, on purpose.** A group headline is N entities ×
several queries on N pooled connections; that does not belong on a home page
that renders on every visit. Consolidated reporting is an on-demand page, and
the existing connection discipline (one connection at a time) is preserved.

**Explicitly deferred (and why)**
- **Posting elimination journals into entity ledgers**, and **auto-mirrored
  intercompany invoices/loans** (a bill in A creating an invoice in B): both are
  cross-tenant *writes*, which would require a session that can write to two
  organizations — exactly the isolation boundary this design refuses to weaken.
  Each entity records its own side normally and consolidation reconciles them.
- **Non-controlling interests / partial ownership**: needs NCI equity and profit
  attribution; not tractable to do half-correctly, so the group model is 100%
  owned subsidiaries only and has no ownership column. Investment-in-subsidiary
  vs. subsidiary equity is not auto-eliminated (it needs acquisition-date
  accounting); record it as a manual adjustment.
- **Mixed-currency translation** (closing/average rates, translation reserve):
  no verified rate mechanism exists; mixed groups are refused, not guessed.
- **Consolidated budgets, group-level month-end close, group-level payroll,
  scheduled consolidation snapshots** (no job queue), **group trial balance**
  (derivable from the entity trial balances; not required by the brief),
  **comparison periods** on consolidated reports, and **sharing a group** with a
  second user (a group is private to its owner).

**Phase 9's last slice** — accountant practice management and workpapers (§42/43) — follows below.

## Phase 9 Slice 5 — Accountant practice management and workpapers — complete (closes Phase 9)

Master spec §42 (accountant/bookkeeper edition: practice dashboard, client groups,
staff assignment, tasks, deadlines, workpapers, review notes, client queries,
document requests, tax calendar, bulk actions), §43 (digital working papers) and
§72 (Business vs Accountant mode on the same engine). Design detail:
`docs/security.md` §13 (the practice scoping model, the consent handshake,
revocation and retention, seats, the AI no-leak guarantee), `docs/accounting-engine.md`
§17 (the workpaper reconciliation method), `docs/database.md` §2q, `docs/ai-agents.md`.

**The central design decision: practice-internal data is isolated by a single-value
predicate on the USER plus practice membership; client data is never reached through
the practice.** A practice (accounting firm) has several staff, so the previous
slice's `owner_user_id = app.current_user_id` cannot apply. Practice tables carry
`practice_id`, and every policy is `EXISTS (SELECT 1 FROM practice_members pm WHERE
pm.practice_id = <row>.practice_id AND pm.user_id = app.current_user_id AND pm.status
= 'ACTIVE')` — one session variable, one membership check, no bypass, no
SECURITY DEFINER, no multi-valued predicate. `practice_members` is the gate and is
protected without recursion by a trivial own-row anchor table (`practice_partners`);
a read-only mirror (`practice_roster`, kept equal by a cascading composite foreign
key) is the colleague directory. The isolation audit classifies the 18 practice tables
and fails the build log if a policy loses the membership check. A user outside the
practice cannot read or write any practice row, even by calling `withUserScope`
directly (tested table by table).

**Reading a client's data goes through the client's own services, one client at a
time, sequentially**, each inside `withTenant(clientOrgId)` with an `Actor` built
from the staff member's **real membership role in that client** (`requireClientActor`:
membership first, then the client's own consent record re-checked immediately before
the read). A practice link grants nothing by itself; a platform admin gets nothing
extra (there is no admin branch). The only client-tenant writes are explicit and
permission-checked: the consent record, `client_requests` and informational audit notes.

**Built**
- **Practices and staff**: any registered user sets up a practice and becomes its
  first PARTNER; roles PARTNER / MANAGER / STAFF; staff are existing users added by
  email (same pattern as `addMemberByEmail`); a partner can only step down or leave
  themselves (the anchor is own-row-only), a practice always keeps one partner; limits
  (3 practices per user, 25 staff).
- **Client links — a two-sided handshake.** The practice proposes by organization slug;
  the authoritative consent record is `practice_client_consents` in the **client's own
  tenant**; only the client's OWNER/ADMINISTRATOR (`organization:manage`) can accept,
  decline or revoke, and may re-approve. **Revocation is immediate**: every read first
  re-checks that row, so the next read after a revoke is refused, with no practice-side
  action needed. The practice learns its working copy is stale when it next verifies
  (dashboard load verifies the page's rows; "Check status" does too) and then blanks the
  retained snapshot figures. **Retention**: practice-owned history (tasks, workpapers,
  review notes, sign-offs, evidence) is kept, shown "as of" its snapshot date and clearly
  marked; nothing new can be read. Proposal spam is bounded (generic error, 5 pending per
  organization, 100 links per practice).
- **Seats**: staff must be real members of each client, which uses that client's seat
  (the two-seat limit from the platform-admin slice is untouched). When a client is full
  the practice sees a specific message with the seat position ("2 of 2 seats used … the
  platform administrator can raise the limit … not bypassed") instead of a cryptic failure.
- **Dashboard** (`/practice`, paginated at 10): Client | Books | Reconciliation | BAS/Tax |
  Payroll | Issues | Assigned to | Snapshot age, with traffic lights worst-first and a
  needs-intervention filter. Indicators come from the existing engines — Books = the
  month-end checklist's progress/blocking for the previous month (`CloseChecklistService`,
  not re-derived), Reconciliation = counts from the new `ReconciliationService.getSummary`,
  Payroll = `PayRunService.countDrafts` (only with `payrun:read`, else "not visible to
  your role"), tax-lock = `PeriodCloseService.getTaxLockedThrough`. **BAS/Tax shows only
  the deadline the practice typed in** and the client's tax-lock; there is no BAS/GST
  feature in this codebase and none is fabricated.
- **Connection budget** (production-incident lesson): the dashboard is read from
  materialised `client_health_snapshots` (counts only), never recomputed across clients;
  Refresh is per client or per page, strictly sequential (no `Promise.all` anywhere,
  asserted structurally and by instrumentation: at most one scoped transaction is ever
  open), bounded to 10 clients, with the snapshot age shown honestly ("as of 2 hours ago",
  "stale" after 24 h). Every list is capped (page 10, bulk 10, 100 links, 25 staff).
  Each viewer sees an indicator only if THEIR role in that client allows it — a snapshot
  refreshed by a colleague with more permissions does not widen what you see.
- **Client groups, staff assignment, bulk actions** (bulk-assign, apply group, create a task
  per client, refresh — all bounded and sequential). Assignment grants no client access
  and leaves an opaque note in the client's own audit log.
- **Tasks, deadlines, tax calendar**: practice-owned `practice_tasks` (client optional,
  priority, category, assignee); recurring deadline **rules the practice writes**
  (frequency, period-end month, months after, due day) with on-demand, idempotent
  generation of the next occurrences; starter templates are labelled editable suggestions
  to verify at ato.gov.au — no due date is hardcoded as authoritative.
- **Client queries and document requests** (`client_requests`, `client_request_messages` —
  tenant tables with RLS in the client org): raised by practice staff with their real role
  (`client_request:manage`), read/answered by the client (`client_request:read` /
  `client_request:respond`) in a "Requests from your accountant" inbox, with attachments
  through the receipt storage abstraction and its shared validation. In-app only — no email.
- **Workpapers** (§43): balance-sheet account reconciliation. A labelled point-in-time
  snapshot of the account balance ("per ledger as at <date>, pulled <timestamp> by <who>")
  with an append-only pull history; a reconciliation schedule with the exact-decimal
  difference (ledger − schedule); evidence held by the practice (bytea, same validation);
  proposed adjustments recorded as notes, **never posted**; review notes (resolve, never
  delete, text immutable); preparer then reviewer sign-off (reviewer ≠ preparer when the
  practice has two or more staff; documented single-staff exception, flagged); immutable
  once signed off (database-enforced) with reopen-with-reason starting a new version over an
  append-only history; carry-forward (structure + recurring lines + comparative, never
  evidence/sign-offs/notes); a one-query stale-snapshot warning on view. A test proves the
  client's ledger (journal entries, lines, trial balance, audit ids) is byte-identical after
  a full workpaper lifecycle.
- **Business vs Accountant mode** (§72): a per-browser cookie toggle that relabels the
  accounting terms (General Ledger / Journals / Trial Balance vs Accounts & reports / Manual
  entries / Account balances) and shows the Practice entry points — presentation only; no
  permission, data or calculation changes.
- **AI (optional, read-only)**: Controller tools `practice_overview` and `workpaper_status`
  (saved snapshots and the practice's own records; per-client real-role gates; unreachable or
  revoked clients excluded as counts) and an optional workpaper commentary over
  already-computed facts (omitted without an API key). No write tools; autonomy and
  period-close exclusions unchanged and re-asserted.

**Explicitly deferred (and why)**
- **Automated BAS/GST preparation and ATO lodgement**: needs the later Phase 8 tax
  features and ATO credentials; the calendar is user-entered.
- **Email/SMS notifications** for requests and deadlines, and **scheduled/automatic snapshot
  refresh**: no messaging infrastructure and no job queue.
- **A client portal for non-members**: needs a different auth model (Phase 3's customer-portal
  deferral applies); clients answer requests as ordinary organization members.
- **Time-and-billing for the practice itself**, **workpaper kinds beyond balance-sheet account
  reconciliation**, **cross-practice data sharing**, removing another partner (a partner can
  only step down; adding a quorum rule is future work), per-practice customised dashboard
  thresholds, and a practice-level audit-log page (the append-only log is written and tested;
  there is no browse UI yet).

**Verification (what was run for real)**
- `npm run typecheck`, `npm run lint`, `npm test` (121 files, 1257 tests: the 1088 existing plus 169
  new), and `npm run build` (migrations 0040/0041 applied, isolation audit "18 practice-scoped
  tables" green, `next build` compiled) all pass.
- Integration tests against the real Postgres test database cover: the practice gate (an outsider and
  a removed member read nothing and write nothing in any practice table, even via `withUserScope`),
  the handshake (only a client OWNER/ADMINISTRATOR accepts; revocation refuses the very next read),
  the dashboard (exactly the readable client A; pending B, revoked C and non-member D contribute no row
  and open no tenant transaction; hand-checkable indicators; payroll hidden for a role without
  `payrun:read`), sequential and bounded access by instrumenting `withTenant`/`withUserScope`
  (at most one scoped transaction open at a time; one consent check per page row), client requests
  (RLS isolation for the new tenant tables, append-only thread), workpapers with hand-verified numbers
  (ledger 12,000.00 = statement 12,450.00 + outstanding -450.00 gives 0.00; a -350.00 item gives -100.00),
  evidence validation, reviewer-not-preparer and the single-staff exception, immutability enforced by
  the database as the real `mm_app` role, reopen with reason, carry-forward rules, a client ledger that
  is byte-identical before and after a full workpaper lifecycle, the seat-limit message, and the AI
  tools' no-leak tests with a mocked model.
- A scripted real-HTTP smoke test against `next start` with real NextAuth credential logins (four
  users; the forms were posted exactly as a no-JS browser does): practice set-up, staff added, client
  handshake, dashboard Refresh (per client, per page and bulk), a BAS task driving the BAS/Tax light,
  a workpaper taken through schedule, evidence, preparer sign-off, a reviewer's note, a
  segregation refusal and a second user's reviewer sign-off, a client-visible request answered by the
  client with an attachment that the practice downloaded, the Business/Accountant toggle, and
  revocation dropping the client from the dashboard while the signed-off workpaper stays readable
  as of its snapshot date. (That run found and fixed one real bug: a per-row Refresh button inside the
  bulk form lost its client id because a server-action button's `name` is replaced by the action id.)
- Not exercised in a browser: visual styling and mobile layout were not inspected (no browser was
  available); only the rendered markup and behaviour above were checked. The Anthropic API itself is
  only exercised through the mocked SDK, as in earlier slices.

**Phase 9 is complete.** Remaining on the roadmap: **Phase 8's later slices** (BAS/GST,
STP lodgement, award interpretation and the other compliance features) and **Phase 10**
(public API, webhooks, integration marketplace, advanced automation centre).

## Platform admin & seat limit — complete

Built to the owner's brief: "an admin section accessible from
typhoon.tall69@gmail.com only, with access to upgrade users, financials and
reports; two users can share the same account; more will be a paid add-on
later." Interpreted (owner-confirmed): *financials and reports* = **platform
business metrics only** (never any customer's books); *upgrade users* = grant an
organization extra seats / change its plan tier **and** change a user's role in
an organization.

**Built**
- **Admin gate** — `PLATFORM_ADMIN_EMAILS` env var (fail closed, normalised
  comparison, DB-sourced email), `requirePlatformAdmin()` on every page, route
  handler and server action, 404 for everyone else, service-layer re-check,
  admin link only server-rendered for admins. See `docs/security.md` §10.
- **Case-insensitive email uniqueness** (CHECK + `lower(email)` unique index,
  normalise-on-write) closing the look-alike-account hole in an app with no
  email verification.
- **Dashboard**: users (active/suspended), organizations, seats used vs
  allowed, orgs at/over limit, plan-tier breakdown, signups per week/month,
  recent signups, recently suspended — all SQL aggregates over the three
  non-tenant tables.
- **Directory**: searchable, paginated organizations and users; org and user
  detail pages (members, roles, join dates, seats, plan, recent admin actions);
  an "at/over seat limit" filter; CSV export of directory data (formula-
  injection-safe, itself audited).
- **Upgrade controls**: set an organization's seat limit and plan tier; change a
  member's role; remove a member — through the same shared membership rules as
  an organization's own settings (last-OWNER protection, role validation).
- **Suspend / reactivate** a user; sign-in refused and existing JWT sessions cut
  off on the next request; an admin can't suspend themselves.
- **Admin audit trail**: append-only `platform_admin_audit_logs` (mm_app
  INSERT/SELECT only) + a matching entry in the affected organization's own
  audit log; an admin audit page with action/organization/date filters.
- **Seat limit (two people share an account)**: `organizations.seat_limit`
  (default 2), grandfathering of existing >2-member orgs, race-safe service-layer
  enforcement (row lock), a typed `SeatLimitReachedError` whose message explains
  the paid add-on and who to contact, and a settings page showing
  "Seats: N of M used" with the invite control disabled when full. The org's own
  settings also gained last-OWNER protection, role validation, and
  re-activation of a previously removed member (previously a re-add hit the
  unique index).
- Reserved organization slugs (`admin`, `app`, `api`, `login`, `register`) so a
  customer can't claim a slug that shadows a real route.

**Deferred (deliberately)**
- **Billing / paid extra-seat add-on**, pricing, Stripe, invoices: only a
  `plan_tier` label and an admin-set `seat_limit` exist.
- **Self-service seat purchase** by an organization owner (the limit message
  tells them to contact the platform admin; no upgrade button is offered).
- **Impersonation / "log in as user"**: explicitly out of scope.
- **Email verification** — **recommended next, and the most important
  follow-up**: a single-email gate on an unverified-email credentials login is
  the weakest link in the platform's security (see `docs/security.md` §10.2).
- **MFA / passkeys for the admin account**, and login rate limiting.
- Pending-invitation seats (there is no invitation concept yet; if invites are
  added they must count toward seats).
- Per-organization suspension (only user-level suspension exists), bulk
  actions, and emailing affected users.
- Notifying customers in-app of platform changes beyond the org audit-log entry
  (there is no org-facing audit-log page yet).

## Shared access UX (read-only colleagues, safe role picker, concurrent-edit guard) - complete

Goal (from the owner): add a second person to the same company file so both can be signed
in at once, read-only so they cannot break anything. The base already existed (add member
by email, a `READ_ONLY` role, a two-seat limit, JWT sessions, server-side permission
checks); this slice makes it safe and coherent to use. Details: `docs/security.md` section 14.

**Built**
- Add-member and change-role pickers: `READ_ONLY` preselected, roles ordered least to most
  privileged, plain-language description plus "can change / can only view" derived from the
  permission matrix, and a required confirmation for any role that can change financial
  data. The confirmation is **enforced server-side** (`WriteAccessConfirmationRequiredError`).
- `isReadOnlyRole(role)` (derived from the matrix, tested over every role) drives a
  persistent read-only banner in the org shell - no new queries, it uses the role the
  layout already loads.
- Write controls hidden for roles lacking the permission: the top-bar create action, primary
  "New ..." buttons on Projects, Payroll (employees, pay runs), Expenses, Fixed Assets,
  Inventory, Budgets, Journals; edit/post/void-style controls on project time logging and
  invoicing, pay run, employee, product, budget and draft invoice/bill pages; write-only
  pages (about 25 "New ..."/depreciation/tax-code/chart-of-accounts forms) show a friendly
  view instead of a form that could only fail. Shared helpers: `Can`, `deniedViewUnless`,
  `createActionsFor`. Sales, Purchases, Money, Forecasting and the other detail pages were
  already guarded in earlier slices (audited, unchanged).
- Permission denial is a friendly state, not a 500: org-level `error.tsx` reads
  `PermissionDeniedError.digest`; `PermissionDeniedError`'s message now ends with who to ask.
- The org home page no longer calls ledger services for roles without `journal:read` /
  `account:read` (an EMPLOYEE would previously have hit a permission error there).
- Optimistic concurrency (`StaleEditError`) for **draft invoices and draft bills**.

**Deferred / not covered**
- Optimistic concurrency for other editable entities (quotes, recurring templates, contacts,
  projects, budgets, scenarios, draft journals, ...) - they remain last-write-wins.
- Read-only "ask <owner name>" in the banner (would need an extra query; the banner says
  "the company owner"). Presence indicators / live "someone else is editing".
- **Pending invites for emails that have not registered yet, and any email sending, are a
  candidate follow-up awaiting the owner's decision - deliberately not built.**

## Phase 10 — Platform (not started)

(With Phase 9 complete, the remaining roadmap is Phase 8's later slices — BAS/GST, STP lodgement, awards — and this phase.)

Public API, webhooks, integration marketplace, advanced automation centre.

## Explicit non-goals for this session

Everything not in Phase 1 above. Building shallow stubs across all 10 phases
would violate master spec §82 ("do NOT attempt to implement 80 superficial
features simultaneously... build vertical slices") and §85 (a feature isn't
done until it has correct domain behavior, permissions, audit, tests). Phase
1 is built to that bar; later phases are sequenced, not started.
