# Feature coverage audit — master spec vs. the code

Audited 2026-10-11 against branch `claude/confident-cannon-wwxh55` (tip after the menu refresh). Five read-only passes
covered all 88 spec sections by inspecting code, schema and routes (the roadmap was used as a pointer only). Nothing
was executed: BUILT means the code and its tests exist, not that a run was observed. Statuses: **BUILT**, **PARTIAL**
(says what is missing), **MISSING** (not built and not recorded as deliberately deferred), **DEFERRED** (recorded in
`docs/roadmap.md` or an ADR with a reason; the reason is usually external credentials, unverified regulatory figures,
or an owner decision).

Corrections found while consolidating: the roadmap still lists BAS and Phase 8 Slice 5 items as "open" in a few places
although BAS is built; the specialist-agent deferral for Payroll and Tax agents cites "no payroll domain", which is no
longer true; `docs/security.md` §6 still mentions Prisma. A sales credit-note path does **not** exist (only supplier
credits), contrary to one pass's reading of the roadmap — confirmed in the schema. Timesheets exist on the project page;
there is no standalone Timesheets screen or nav entry.

## Summary by area

| Area (spec §) | Verdict |
|---|---|
| Ledger, posting, periods, audit, tenant isolation (4, 41, 44, 48, 63) | BUILT. Gap: posted-entry immutability and period locks are enforced in application code, not by database triggers. |
| Dimensions (5) | PARTIAL. Only manual journal lines carry dimensions; invoice/bill/expense/payroll lines do not. |
| Dashboard and briefs (6, 73, 74) | PARTIAL. Home page is thin; no AI Insights objects; Executive Brief missing. |
| AI controller, autonomy, agents, learning, override (7–9, 76, 77) | PARTIAL. Read tools, drafts, autonomy 0–4 (3 whitelisted actions) built. Anomaly/duplicate/accrual tools, Payroll and Tax agent modes, learned preferences missing. |
| Banking, reconciliation, rules (10–12) | PARTIAL. CSV/OFX/QIF import, one-to-one matching, AI fuzzy match, rules built. Split / one-to-many / many-to-one / bulk reconcile, richer rule actions and CAMT missing. Live feeds DEFERRED (credentials). |
| Sales and AR (13–15) | PARTIAL. Quotes, invoices, recurring, aged AR, collection score built. Credit notes, customer credits, deposits, statements, receipts, sales orders, templates missing. Portal and reminder sequences DEFERRED. |
| Accounts payable, documents, expenses (16, 17, 19) | BUILT/PARTIAL. Bills, POs with 3-way match, supplier credits, payment runs, expense claims, receipt AI built. Mileage, policies, cards, extra extracted fields, bill capture page missing. |
| Fraud and duplicate detection (18) | MISSING entirely. |
| Inventory, projects, time (20–23) | PARTIAL. Weighted-average stock, reorder alerts, projects, timesheets, time billing built. FIFO, locations, lots, stock takes, intelligence DEFERRED/MISSING; no labour cost rate so project cost excludes labour. |
| Payroll and leave (24, 25) | PARTIAL. Employees, pay runs, PAYG (approximation), super incl. Payday Super, payslips, settlement, remittance, leave workflow, reports built. HELP/LITO/no-TFN/WHM, overtime/allowances/deductions, rostering, LSL, custom leave types, STP lodgement missing or DEFERRED. |
| Tax and BAS (26, 27) | PARTIAL. GST/BAS prep with drill-down, reconciliation, finalise+hash built. BAS checks for uncategorised bank items / missing documents / prior-period / anomalies missing; lodgement DEFERRED; no org tax-registration fields; no non-AU packs. |
| Fixed assets (28) | BUILT for straight-line; other methods, transfer, revaluation DEFERRED. |
| CRM-lite (29) | PARTIAL. Customer page lacks quotes, payments list, projects, documents, LTV, customer-level outstanding. |
| Multi-entity (30), multi-currency (31) | Multi-entity BUILT (consolidated P&L/BS/cash) with eliminations in memory only. Multi-currency PARTIAL: columns and posting maths exist, but no rate source, no revaluation, no FX gain/loss; `exchange_rates` is unused. |
| Reporting (32–35) | PARTIAL. Core statements, aged reports, builder, NL reporting, management pack (5 sections) built. Customer statements, GL report, revenue/margin by customer/product, PDF/Excel export, scheduled packs, remaining pack sections missing. |
| Budgets, scenarios, cash flow (36–38) | BUILT (rolling advance and tax/subscription forecast inputs DEFERRED). |
| Financial health score (39) | MISSING. |
| Close, locking (40, 41) | BUILT. Two-person reopen, year-end close, configurable fiscal year DEFERRED. |
| Practice mode, workpapers (42, 43) | BUILT for balance-sheet reconciliation workpapers; adjustments are notes (never posted); no practice audit-log UI. |
| Approval engine (45) | MISSING (single-step approvals exist for payment runs, expenses, leave, timesheets). |
| Roles (46) | PARTIAL. 10 roles; no CFO/External Auditor; no per-branch/department/bank-account restrictions. |
| Security (47, 49–52) | PARTIAL. CSP/headers, RLS, secrets, hashed keys, AI permission parity built. MFA DEFERRED; login rate limiting/lockout and new-device signal BUILT (security.md s.22); email verification, password reset, dependency scanning/CI, IP/device audit capture, AI prompt-injection tests, supplier bank-detail change controls MISSING. |
| Integrations, API, OAuth, webhooks (53–55) | BUILT framework (Slack real, 17 providers "coming soon"); API v1 drafts-only; OAuth auth-code+PKCE; webhooks with outbox. `payroll.completed` / `bank.transaction.created` events and a scheduler DEFERRED. |
| Search, create button, command bar (56, 57, 80) | Global search / Cmd+K MISSING; "+ Create" has 1 of 9 entries (pages exist); AI controller is the only command surface. |
| Navigation (59), onboarding (60), migration (61) | Nav PARTIAL (flat list; no Payments list, Timesheets entry, Dashboards). Onboarding 4-step wizard PARTIAL. Migration engine and Xero/MYOB/QuickBooks importers MISSING. |
| Notifications, mobile, accessibility, performance, testing (66–70) | Notification centre BUILT (no system producers, email, push). PWA MISSING; a11y PARTIAL (no skip-link, no reduced-motion handling, no a11y tests); no e2e tests; no virtualised tables. |
| Demo company (71) | PARTIAL. Seed has a chart and ~28 journals, not the 32-employee/600-customer Northstar dataset. |
| Modes (72), automation (75), design system (78), errors (79), flags (81) | Modes BUILT (vocabulary partial). Automation centre BUILT (3 of 6 examples; others DEFERRED). Design system PARTIAL (~14 spec'd components absent). Feature flags MISSING (unfinished modules are simply left out of nav). |

## Ranked gaps (consolidated)

Needs-nothing-external items first; "Ext." = needs credentials, a provider account, or an owner decision.

| # | Gap | Effort | Ext. |
|---|---|---|---|
| 1 | Fraud / duplicate detection (duplicate bill number/amount/file hash, anomaly queue, risk score) — §18 | L | no |
| 2 | Sales credit notes, customer credits/overpayments, deposits, statements, receipts — §13 | M–L | no |
| 3 | Approval engine (tiered rules, approver inbox) — §45; unblocks two-person reopen and "over $X → CFO" | L | decision |
| 4 | Reconciliation breadth (split, one-to-many, many-to-one, bulk) and richer bank-rule actions/conditions, AI rule suggestions — §11–12 | L | no |
| 5 | Line-level dimension tagging on invoices/bills/expenses/payroll — §5 | M | no |
| 6 | Dashboard home metrics, AI Insights (Why / Show me / Fix it), Executive Finance Brief, Risk/Opportunity brief items — §6, 73, 74 | M–L | decision on insight set |
| 7 | Global search / Cmd+K command bar; full "+ Create" menu (S) — §56, 57, 80 | M (S for Create) | no |
| 8 | Migration engine + importers (Xero, MYOB, QuickBooks, CSV) and opening-balance entry — §60–61 | L | file formats |
| 9 | Financial health score — §39 | M | weights decision |
| 10 | Login security: rate limiting (S), email verification and password reset (need email provider), MFA/passkeys (L) — §47 | S–L | email provider |
| 11 | Org-facing audit-log page; IP/device and prompt-version capture — §44 | M | no |
| 12 | Database-enforced immutability of posted entries and period locks (trigger/policy) — §4, 63 | S–M | decision |
| 13 | Management pack sections (Executive Summary, KPI scorecard, forecast, AR, AP, cash, key changes) + PDF/Excel export — §35 | M (PDF/Excel M–L) | library choice |
| 14 | Reports: customer statements, GL, GST detail, revenue/margin by customer/product, bills due — §32 | M–L | some need salesperson/location data |
| 15 | Multi-currency: rate source, revaluation, realised/unrealised FX, consolidation translation — §31 | L | rate provider |
| 16 | BAS prep checks (uncategorised bank items, missing documents, prior-period comparison, anomalies) — §27 | M | no |
| 17 | Payroll breadth: overtime, allowances, deductions, TFN declaration, public holidays; HELP/LITO/no-TFN/WHM/NAT 1004 (verified figures needed); LSL; STP lodgement — §24–25 | M–L | verified figures / ATO credentials |
| 18 | Rostering, team leave calendar, custom leave types, workforce-cost forecast — §25 | L | no |
| 19 | CRM-lite customer record (quotes, payments, projects, docs, LTV, correspondence) — §29 | M | no |
| 20 | AI: Payroll and Tax agent modes (S), anomaly/duplicate/accrual/variance/scenario tools, structured org-preferences ("AI learning") — §7, 9, 76 | S–M each | decision for learning |
| 21 | Inventory depth: FIFO, locations, lots/serials, stock takes, stockout forecast, slow-moving analysis — §20–21 | L | no |
| 22 | Project labour cost (employee cost rate), milestone invoicing, quote→project link — §22 | S–M | no |
| 23 | Expense policies, mileage, allowances, corporate cards — §19 | M | cards need provider |
| 24 | Document AI: extra fields (ABN, invoice no., due date), bill capture page; email ingestion (provider) — §17 | M | email provider |
| 25 | Journal-level recurring/accrual/prepayment/allocation schedules — §4 | M–L | scheduler decision |
| 26 | PWA, accessibility pass (skip link, reduced motion, tests), e2e tests (Playwright), CI + dependency scanning — §67, 68, 70, 47 | M each | no |
| 27 | Design-system components (DataTable, selectors, DatePicker, etc.) — §78 | L | no |
| 28 | Missing roles (CFO, External Auditor, S) and finer restrictions (L) — §46 | S–L | decision |
| 29 | Supplier bank-detail change controls (needs supplier bank fields first) — §52 | M | no |
| 30 | Demo company at spec scale (Northstar) — §71 | M | no |
| 31 | Events `payroll.completed`, `bank.transaction.created`, `period.closed`; scheduler/global dispatcher — §55, 65 | M | owner reversal of "no scheduler" |
| 32 | Feature flags — §81 | S | no |
| 33 | External: live bank feeds (Basiq/CDR), Stripe/PayPal/Square, customer portal with e-signature and payments, reminder sequences (email), real third-party connectors — §10, 14, 15, 51, 53 | L each | credentials/accounts |

## Deliberate deferrals that still stand
Live bank feeds, card payments, email/SMS delivery, customer portal, job queue/scheduler (owner decision: on-demand
only), ATO lodgement (BAS, STP), Teams connector, regulatory figures that could not be cross-confirmed (HELP/STSL,
LITO withholding, WHM, no-TFN wage rate, NAT 1004 coefficients, BAS labels 8A/8B/9/W3–W5/5A/5B/7, BAS due dates).
