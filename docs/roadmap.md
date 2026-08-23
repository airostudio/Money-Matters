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

## Phase 3 — Sales (not started)

Customers, quotes, invoices (incl. recurring/progress/milestone), payments,
AR aging, customer portal, smart debt collection.

## Phase 4 — Purchases (not started)

Suppliers, purchase orders, bills, three-way matching, AP, payment runs,
approval engine.

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
