# AI Agents (architecture; the AI Financial Controller foundation shipped in Phase 6 Slice 1)

The specialist agents and autonomy levels described below (§3, §4) remain
Phase 6 Slice 2+ work. The AI Financial Controller itself — the foundation
those future specialist agents and the autonomy framework will sit on top
of — shipped in Phase 6 Slice 1; see §0c for what was actually built, in
place of the "planned shape" this document originally sketched in §2 before
any of it existed. The onboarding wizard's chart-of-accounts recommender
(§0) is the first real AI integration in the codebase, shipped ahead of
Phase 6 as a small, tightly-scoped exception — see §0 for why it doesn't
violate the rest of this document.

## 0. First AI integration: onboarding's chart-of-accounts recommender

`src/domain/onboarding/chart-of-accounts-recommender.ts` (used by the
onboarding wizard at `/[orgSlug]/onboarding`, see `docs/roadmap.md`)
classifies a user's free-text business description into a chart-of-accounts
template. It sets the precedent every future AI feature in this codebase
should follow:

**Classify, then deterministically expand — never generate.** The AI's
entire output is a `templateKey` (one of a fixed, curated set) plus four
booleans (`sellsGoods`, `sellsServices`, `hasEmployees`, `tracksInventory`),
produced via Claude's tool-use feature so the response is schema-constrained
at the API level, and then re-validated against the same schema in code with
zod regardless — a schema constraint on the model side is never trusted as
the only check. The AI **never** emits an account code, name, or number.
Those come from `chart-of-accounts-templates.ts`, a hand-curated, versioned
library of complete charts of accounts (Trades, Professional Services,
Retail, Hospitality, General) that the wizard deterministically expands
using the AI's flags — the same `expandTemplate()` function whether the
`templateKey` came from the AI or from the fallback below. This is the
concrete version of master spec §2/§87.2's "never allow AI to silently
invent financial information": the model influences *which* pre-approved
template and *which* subset of it apply, never what the template contains.

**The fallback is not optional.** `DeterministicRecommender` is a plain
keyword classifier with no network dependency at all. `recommendChartOfAccounts()`
uses the AI path only when `ANTHROPIC_API_KEY` is set, and falls back to the
deterministic classifier — silently, from the user's perspective ("using our
standard template for your industry") — on a missing key, a network/timeout
failure, or a schema validation failure. This means the wizard, and its full
test suite, work with zero network access; only the deterministic path is
ever exercised in CI. The AI path is covered by unit tests that mock the
Anthropic client's `messages.create` response, never a real network call.

**Human confirms, AI informs.** The account-creation step's audit event
(`onboarding.chart_of_accounts_applied`) is recorded with `actorType: HUMAN`
— it's the signed-in owner/administrator who clicks "Create accounts," and
misrepresenting that as an AI-initiated action would be worse than not
recording provenance at all. The AI's contribution (source, model,
confidence, reasoning) is recorded as audit *metadata* on that same human
action instead, alongside the accepted/edited account list — satisfying
"every AI-influenced action needs a why, shown not hidden" (§6) without
overstating who acted. `actorType: AI` (§2 below) is reserved for the AI
literally being the actor performing an autonomous mutation, which this
wizard step is not — a human always reviews and confirms the account list
before anything is created.

**Model choice.** `ANTHROPIC_ONBOARDING_MODEL` (default
`claude-haiku-4-5-20251001`) is deliberately a fast/cheap model — this is a
small structured-classification call with a handful of output fields, not a
freeform reasoning task, so a larger model would add latency and cost with
no accuracy benefit worth paying for at this step.

## 0a. Second and third AI integrations: fuzzy reconciliation and Document AI

Phase 2 Slice 2 adds two more AI integrations, both following the same
"classify/extract, never auto-post" discipline §0 established, extended to
their own shape of the problem.

**Fuzzy reconciliation
(`src/domain/banking/fuzzy-reconciliation-service.ts`).**
`ReconciliationService.findCandidateMatches` (§0's sibling, deterministic
exact-amount matching — see `docs/decisions/0006-bank-feed-abstraction.md`)
is augmented, not replaced, by `FuzzyReconciliationService.suggestMatches`
for the case it was always meant to hand off to: a transaction with no
exact-amount candidate. The AI's entire output is a ranked list of
`{candidateJournalLineId | candidateAccountId, confidence, reasoning}`
entries, produced via a schema-constrained tool call and re-validated with
zod. The extra check this integration needs, that §0's fixed-enum
`templateKey` didn't: the candidate ids are not a small closed set known in
advance, so **every returned id is checked against the actual candidate pool
handed to the model in that call** — a journal-line or account id the model
merely claims, but that wasn't in the list it was given, is silently
dropped rather than trusted. This is the concrete version of "never allow
AI to silently invent financial information" for a case where the invented
thing would be an id rather than a number.

This is a **user-triggered action** ("Get AI suggestions" per bank
transaction), never a background/automatic pass over every transaction —
gated behind its own `bank_transaction:ai_suggest` permission, distinct from
`bank_transaction:reconcile`. It never posts or confirms a match itself:
every suggestion is surfaced exactly like a deterministic candidate, through
the same `confirmMatch`/`createJournalFromTransaction` calls a human clicks,
with its reasoning shown next to it (master spec §6). Missing
`ANTHROPIC_API_KEY`, a failed/timed-out call, or a schema validation failure
all resolve to an empty suggestion list — the deterministic candidates (if
any) still show, with no error and no AI section, exactly like §0's
fallback UX.

**Document AI (`src/domain/documents/receipt-extraction-service.ts`).**
`AiReceiptExtractor` sends an uploaded receipt/invoice image or PDF to
Claude using its vision capability (a base64-encoded image or document
content block), via a schema-constrained tool call extracting
`{supplierName, date, subtotal, taxAmount, total, currency, lineItems,
suggestedCategory, confidence, reasoning}`, re-validated with zod exactly
like every other AI response in this codebase. This is master spec §17's
"never silently post uncertain OCR results" made concrete: the extraction
result is never written onto an expense claim or bill directly — it only
ever pre-fills an editable draft (`/[orgSlug]/expenses/new?receiptId=...`)
that a human reviews, edits, and explicitly confirms via the same
`ExpenseClaimService.create` call an unassisted draft would use, which does
its own independent validation regardless of what the AI produced. A
missing API key, an unsupported file type, a network failure, or a schema
validation failure all resolve to `null` — the upload still succeeds, the
user just gets a blank draft to fill in manually rather than a pre-filled
one, per the task's explicit requirement that the feature never blocks
entirely on AI being configured.

The uploaded file itself is stored as `bytea` in Postgres
(`uploaded_receipts`) behind a small `DocumentStorageProvider` interface —
a deliberate, temporary decision (no object-storage credentials are
available in this environment) recorded in
`docs/decisions/0007-document-storage-bytea.md`, the same shape as the bank
feed provider abstraction: ship the credential-free path now, make a real
object-storage provider (S3, Vercel Blob) an additive swap later.

## 0b. Fourth AI integration: Natural-Language Reporting (Phase 5 Slice 2)

Master spec §34 states this codebase's discipline more explicitly than any
other section of the spec, so it's worth quoting in full:

> "interpret question → generate a safe structured analytics request →
> query validated financial data → calculate result deterministically →
> render chart/table → explain. Never ask the LLM to calculate large
> financial datasets directly from text."

`src/domain/reporting/nl-report-query.ts` and
`src/domain/reporting/nl-reporting-service.ts` implement exactly that
pipeline, as a different front door onto Phase 5 Slice 2's report builder
(`src/domain/reporting/report-builder-service.ts`) rather than a separate
feature:

1. **Interpret.** `NLReportingService.ask` sends the user's plain-English
   question to Claude via a schema-constrained tool call (`structure_report_request`),
   the same `tools`/`tool_choice` mechanism as every other AI integration
   here. The model's context includes the organization's real dimension
   names/values (for matching "marketing" or "Project X" against something
   real) but **never any balance, total, or other computed figure** — it
   doesn't need one to do a classification task, and keeping it out of the
   prompt means there is nothing sensitive for the model to leak or
   misremember.
2. **Structured request.** The tool call's output is `NLReportRequest`: one
   of six fixed `metric` values, one of nine `period` shapes, a `breakdown`,
   and optional `dimensionKey`/`dimensionValue` strings — re-validated with
   zod (`NLReportRequestSchema`) exactly like every prior AI response in
   this codebase, never trusted because the tool schema already shaped it.
   This is the **entire** output the AI is allowed to produce. It is not
   SQL, not a number, not a report.
3. **Deterministic resolution.** `resolveNLReportRequest` is a pure function
   that turns `NLReportRequest` into the exact same `ReportBuilderConfig`
   shape a human builds by hand in the Report Builder UI — resolving
   "last quarter" against the real calendar, and matching `dimensionKey`/
   `dimensionValue` against the organization's actual dimensions. A
   dimension reference that doesn't match a real one is a **hard failure**
   returned to the user as a clarification request, never a guess — the
   same "never trust a reference the model merely claims, only one that was
   actually in the list it was given" discipline §0a's fuzzy reconciliation
   established for candidate ids, applied here to dimension names.
4. **Deterministic execution.** The resolved config is handed to
   `ReportBuilderService.runConfig` — the identical function call the Report
   Builder page itself makes. Nothing about that function knows or cares
   whether its input came from a form submission or an AI-interpreted
   question. The AI's job ends at step 2; it never computes a number, and it
   never sees one before the user does.
5. **Render and explain.** The result renders through the same
   `ReportResultTable` component as the Report Builder, with a one-line
   plain-English restatement ("Showing: Revenue, by month, for the last 12
   months") above it so the user can confirm the system understood them
   correctly before trusting the numbers (master spec §34's "explain" step).

**No deterministic fallback that answers the question.** Every other AI
integration in this codebase (§0, §0a) falls back to a deterministic
alternative that still completes the task when the AI is unavailable — the
whole point of their mandatory fallbacks. NL reporting is the one exception,
on purpose: there is no safe deterministic way to guess what a free-text
question meant. Falling back to "assume they meant the most recent month" or
similar would risk confidently showing the *wrong* report for a *different*
question, which is strictly worse than not answering. So a missing
`ANTHROPIC_API_KEY`, a timed-out/failed call, or a schema-validation failure
all resolve to `{ status: "unavailable" }` — the UI tells the user
natural-language queries aren't available right now and points them at the
Report Builder directly. This is the one place in this codebase where
"AI unavailable" means "feature unavailable" rather than "deterministic
fallback," and it is a deliberate, documented exception to §0/§0a's pattern,
not an oversight.

**Management report pack commentary** (`src/domain/reporting/management-pack-service.ts`)
is a lighter-weight fifth use of the same "AI never produces a financial
figure" principle: the model is handed only the already-computed P&L/
Balance Sheet/Cash Flow totals (never raw ledger data) and asked to write
3-5 sentences of prose about them — explicitly instructed to use only the
given figures, never calculate or introduce a new one. Unlike the four
integrations above, there is no schema that can validate "the generated
sentence didn't misstate a number," since the output is prose, not a
structured value — so the commentary is clearly labeled as AI-generated in
the UI and the figures themselves are always shown alongside it, computed
independently and never replaced by anything the commentary says. A missing
API key or a failed call simply omits the commentary section; the pack
itself (three real reports, each independently correct) is unaffected.

## 0c. Fifth AI integration, and the first multi-turn one: the AI Financial Controller (Phase 6 Slice 1)

Every integration above (§0, §0a, §0b) is a single-shot classification or
extraction call: one question in, one schema-constrained answer out. The AI
Financial Controller (`src/domain/ai-controller/`) is the first one that
holds a conversation and decides, turn by turn, *which* of several possible
lookups a question needs — master spec §50's "Intent → Permission →
Validation → Tool → Result → Audit" pipeline, finally built rather than just
diagrammed (§2 below is the diagram this slice implements against).

**The tool list is fixed, explicit, and closed.** The model cannot query the
database, construct SQL, or invoke anything other than the nine named tools
in `controller-tools.ts`: `trial_balance`, `profit_and_loss`,
`balance_sheet`, `aged_receivables`, `aged_payables`, `find_invoice`,
`find_bill`, `find_expense_claim`, and `run_report` (a generalized
open-ended lookup — see below). Every one of them is a thin wrapper around
an already-existing, already-tested domain-service method
(`LedgerService.getTrialBalance`, `ReportingService.getProfitAndLoss`,
`AgedReceivablesService.getWithPriority`, …); none of them is new query
logic invented for this feature. `run_report` is the one exception worth
calling out by name: rather than becoming a second, parallel "ask it
anything" path alongside NL reporting (§0b), it reuses
`resolveNLReportRequest` and `ReportBuilderService.runConfig` **verbatim** —
the Financial Controller's open-ended tool and the dedicated "Ask a
question" page share one interpretation→resolution→execution pipeline, not
two that could drift apart. None of the nine tools writes, posts, approves,
or modifies anything — this slice is deliberately read-only; an
action-taking command bar is explicitly Slice 2 work (§3/§4 below).

**The permission check is never skipped, elevated, or re-implemented.**
Every tool wrapper takes the real, authenticated `Actor` the person is
signed in as and passes it straight into the underlying domain-service call
— the exact same `assertPermission(actor, …)` that call already runs for a
route handler. There is no second, AI-specific permission layer to keep in
sync with the real one, which is the whole point: master spec §49's "if a
staff member cannot access payroll through the application, 'Show me
everyone's salaries' must also be denied by the AI" is true *structurally*,
because the AI path and the UI path are, past the point of the user's
question, the identical function call. A `PermissionDeniedError` is caught
in `controller-tools.ts`'s `guarded()` helper and turned into a plain-
language refusal the model is instructed (and, by the tool's own output,
unable to do otherwise) to relay honestly — it is never swallowed into a
success, and the model is never given an alternate path to the same data.

This is proven, not merely argued, by
`src/tests/integration/ai-controller/financial-controller.test.ts`: a real
`EMPLOYEE` actor and a real `PAYROLL_MANAGER` actor, in the real test
database, ask questions that need `financial_report:read`/
`customer_invoice:read` they don't hold, and get a refusal with **zero**
citations recorded — nothing was actually retrieved, not just "not shown."
The same proof was repeated once more over real HTTP against a running
server (see `docs/roadmap.md`'s Slice 1 entry) with a genuinely
authenticated, genuinely restricted-role session, not a mock.

Building this surfaced one real instance of the exact failure class this
design exists to prevent, before it shipped: `run_report`'s tool
description is enriched with the organization's real dimension names (the
same pattern NL reporting's tool schema uses), fetched once per conversation
turn via `DimensionService.listActive(actor)` — which itself requires
`dimension:read`. The first version of this code called it unconditionally,
so an `EMPLOYEE` or `PAYROLL_MANAGER` actor (neither holds `dimension:read`)
got an *uncaught* `PermissionDeniedError` that crashed the entire
conversation turn, not a narrow, graceful refusal of just the data they
couldn't see. The fix falls back to an empty dimension list for that actor
rather than widening the permission check — `run_report` simply won't
mention a dimension by name for them, the same as the Report Builder's own
dimension filter would be invisible to them in the UI. The lesson generalizes:
every piece of context assembled *around* a tool call — not just the tool
call's own result — needs the same permission discipline as the tool call
itself, and a crash is not an acceptable substitute for a refusal.

**The conversational loop.** `FinancialControllerService.ask` sends the
question (plus the prior turns' plain-text transcript — see its doc comment
for why only final answers, not raw tool-use blocks, carry across turns) to
Claude with all nine tools available and `tool_choice: "auto"`. Each round
the model either calls one or more tools — executed, permission-checked,
fed back as `tool_result` blocks — or produces a final answer. This repeats
for up to 5 rounds; the 5th is forced to `tool_choice: "none"` so the
conversation always ends in a narrated answer rather than a silent timeout.
A malformed tool-call argument (schema validation failure on the model's
own `input`) is reported back to the model as a `tool_result` error, not a
crash, exactly like §0a's fuzzy reconciliation never trusts a tool's own
shape without re-validating it. A runtime guard
(`looksLikeUncitedFigure`, deliberately narrow — it only catches a
currency-shaped number such as `$12,345.67`, not a hallucinated figure
spelled out in words, which no cheap regex can catch) refuses a final answer
that states a dollar figure when the model never called a tool that turn —
the common, cheap failure mode of answering from "general knowledge" instead
of looking anything up, treated as a bug to catch at runtime, not something
left entirely to the system prompt's good behavior.

**Citations are computed, never self-reported.** Every successful tool call
returns a `ToolCitation` (which tool, what period, a drill-down link into
the real report page — reusing Phase 5's pages, never a parallel rendering
path) alongside its result. The application appends a deterministic
"Sources" footer built from the citations that were actually collected; the
model is told it doesn't need to list its own sources, so there's nothing
for it to misremember or omit.

**Audit.** Any conversation turn that made at least one tool call — success
or refusal — is recorded via `AuditService.record` with `actorType: "AI"`
(the onboarding wizard's established convention, §0), naming which tools
were called, by whom, for which organization. A turn with no tool call (pure
small talk) logs nothing — not every chitchat turn needs a heavyweight audit
row, but anything that touched financial data is traceable. Unlike a
mutation's audit record (which must share its transaction, per
`AuditService`'s own doc comment), this is a read-only path: the write is
best-effort, wrapped so a failure there never blocks the user from seeing
an answer that was already correctly computed.

**Fallback.** Missing `ANTHROPIC_API_KEY`, a failed/timed-out call, or an
unhandled error anywhere in the loop all resolve to "the AI Financial
Controller isn't available right now" — the same no-fallback-that-answers-
the-question discipline §0b established for NL reporting, and for the same
reason: there is no safe deterministic substitute for "have a conversation
about arbitrary financial questions."

**Daily Finance Brief** (`src/domain/reporting/daily-finance-brief-service.ts`,
master spec §73) is this slice's other half, and a much simpler
application of the same "AI never produces a figure" principle as the
Management Report Pack (§0b): every number — cash position, money in/out
over the next 7 days, overdue receivables/payables, payment runs awaiting
approval — is computed by composing existing domain-service calls (no new
aggregation), and an optional short AI-written summary paragraph sits on
top, given only those already-computed figures and never a source of a new
one. See `docs/roadmap.md`'s Phase 6 Slice 1 entry for the full list of
what each figure reuses and what's deferred (a scheduled/emailed version,
blocked on the still-missing job-queue infrastructure).

## 1. Why this belongs in the Phase 1 docs

The single most important constraint on the AI layer is: **it must never see
or do more than the permission-checked user it acts on behalf of.** That
constraint is cheap to guarantee if it's structural, and expensive to
retrofit if it isn't. Structural means: the AI layer has no database access
and no "AI-only" query path — it only ever calls the same domain services
(`LedgerService`, `AccountService`, `ContactService`, …) that route handlers
call, through the same `assertPermission(actor, …)` choke point described in
`docs/security.md` §4.

## 2. Planned shape: Intent → Permission → Validation → Tool → Result → Audit (built in Phase 6 Slice 1 — see §0c)

```
User/agent request
      │
      ▼
Intent parsing (LLM)          "reconcile everything you're confident about"
      │  interpreted into a *typed* tool call, never a raw SQL/DB action
      ▼
Tool call (typed, schema-validated)   e.g. prepareBankMatch(orgId, bankTxnId)
      │
      ▼
assertPermission(actor, 'bank:reconcile', org)   — same function humans hit
      │
      ▼
Domain service method                 — same LedgerService/etc as UI calls
      │
      ▼
AuditService.record(..., actorType: 'AI', agent, modelVersion, confidence)
      │
      ▼
Typed result back to the agent / UI, always with source transactions +
methodology (master spec §2: "never allow AI to silently invent financial
information")
```

`AuditLog.actorType` (`HUMAN` | `AI`) and the optional agent/model/
confidence columns already exist in the Phase 1 schema (`docs/database.md`
§2 Governance) specifically so this is additive later, not a migration that
touches historical rows.

This diagram is no longer aspirational for the read-only half of it: the AI
Financial Controller (§0c) implements every box above except the "tool call"
being typed in the stricter sense of *writing* anything — Slice 1's tools
are all reads. The write side (`prepareBankMatch`-style mutating tool calls,
behind an autonomy level, with a human-approval gate for high-risk actions)
is Slice 2's command-bar work, described in §3/§4 below.

## 3. Autonomy levels (master spec §8) — modeled, not enforced yet

`Organization` will carry a per-workflow autonomy level (0 Manual .. 4 Finance
Automation). Not implemented yet; noted here so the eventual column
(`OrganizationAutomationSetting`) is understood to key off `(organizationId,
workflowType)`, not a single global switch — different workflows (bank
reconciliation vs. supplier payments vs. payroll) will carry different
autonomy levels per master spec §8's examples. This is Phase 6 Slice 2 work:
it only makes sense once there are mutating tool calls (the command bar) for
an autonomy level to actually gate — Slice 1's tools are all read-only, so
every one of them is effectively "Level 0 Manual" today, trivially and
uniformly, with no column needed yet to say so.

## 4. Specialist agents (master spec §9) — not built yet

Bookkeeping, AR, AP, Payroll, Tax & Compliance, and FP&A agents are Phase 6
Slice 2+ work, coordinated by the AI Financial Controller built in Slice 1
(§0c). Each will be a thin LLM-driven planner over the same domain services
Slice 1's tool registry already calls — none gets bespoke data access, and
none bypasses the permission discipline §0c establishes. Concretely, a
specialist agent is expected to be built as its own, narrower tool registry
(e.g. an AR agent limited to `aged_receivables`, `find_invoice`, and new
AR-specific read tools) plus its own system prompt, reusing
`controller-tools.ts`'s wrapper pattern and `financial-controller-service.ts`'s
loop/guard/audit machinery rather than a parallel implementation of any of
them.

## 5. Non-negotiables carried into every future phase (master spec §87)

- Never invent financial values — always retrieve-then-explain, never
  generate-then-assert.
- Never bypass permissions — enforced structurally per §1 above.
- Never silently perform a high-risk action — payment changes, bank-detail
  changes, payroll changes, tax submissions, unusual journals, period
  closes always require human approval regardless of autonomy level
  (master spec §8).
- Every AI recommendation involving money must be explainable and every
  value traceable to its source transaction(s).
