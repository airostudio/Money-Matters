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

### Slice 2 — not started
Live bank feed provider (Basiq, most likely — AU open banking), AI-assisted
fuzzy reconciliation for transactions with no exact-amount candidate,
document AI (receipt/invoice capture), expense management, object storage
for documents, background job infrastructure (queue), Redis-compatible
cache, Stripe.

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

### Slice 2 — not started
Quotes, recurring/progress/milestone invoicing, customer portal, smart debt
collection.

## Phase 4 — Purchases (in progress)

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

### Slice 2 — not started
Purchase orders, goods-received matching, three-way matching, recurring
bills, supplier credits, batch payment runs, payment approval workflow,
document/receipt capture.

## Phase 5 — Reporting (not started)

Financial statements (P&L, Balance Sheet, Cash Flow), dimensional reporting,
report builder, natural-language reporting (structured-query path, not
free-text LLM math), management report packs.

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
