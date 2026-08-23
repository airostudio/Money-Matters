# Roadmap

Source of truth for scope: the master build prompt (accounting + banking +
payroll + tax + billing + payments + expenses + inventory + projects + CRM +
forecasting + reporting + AI automation + practice management, per its §82
phase breakdown). This file tracks what is actually built vs. planned so
"done" claims stay honest.

## Phase 1 — Financial Foundation — **in progress this session**

- [x] Docs: architecture, accounting engine, database, security, AI agents,
      roadmap, decision records
- [x] App scaffold: Next.js (TS strict, Tailwind, shadcn/ui), layered dirs
- [x] Prisma schema: orgs, memberships, accounts, fiscal periods, journals,
      journal lines, dimensions, contacts, currencies, tax codes, audit log
- [x] Double-entry posting engine (`LedgerService`/`PostingService`) +
      unit + property-based tests
- [x] Auth (NextAuth credentials) + org membership + RBAC permission checks
- [x] AuditService wired into account/journal/contact/membership mutations
- [x] Dashboard shell + role-aware navigation
- [x] Chart of Accounts UI, Journal Entry UI (create/post/reverse), Trial
      Balance report
- [x] Northstar Electrical Group demo seed data
- [x] Tenant isolation integration test
- [ ] MFA/passkey auth — deferred (noted in `security.md`)
- [ ] Period-lock override workflow UI — reject path enforced, override
      workflow deferred to Phase 9 (Close)

## Phase 2 — Money (not started)

Bank feed provider abstraction, bank import (CSV/OFX/QIF), AI reconciliation
matching + explanations, bank rules, document AI (receipt/invoice capture),
expense management, object storage for documents, background job
infrastructure (queue), Redis-compatible cache.

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
