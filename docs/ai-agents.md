# AI Agents (architecture; the AI Financial Controller itself begins Phase 6)

The AI Financial Controller, specialist agents and autonomy levels below are
still Phase 6+ work. The onboarding wizard's chart-of-accounts recommender
(§0) is the first real AI integration in the codebase, shipped ahead of
Phase 6 as a small, tightly-scoped exception — see §0 for why it doesn't
violate the rest of this document. Everything else here remains an
architecture decision recorded *now* so Phase 1's domain layer doesn't have
to be reshaped when the fuller AI layer is built.

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

## 1. Why this belongs in the Phase 1 docs

The single most important constraint on the AI layer is: **it must never see
or do more than the permission-checked user it acts on behalf of.** That
constraint is cheap to guarantee if it's structural, and expensive to
retrofit if it isn't. Structural means: the AI layer has no database access
and no "AI-only" query path — it only ever calls the same domain services
(`LedgerService`, `AccountService`, `ContactService`, …) that route handlers
call, through the same `assertPermission(actor, …)` choke point described in
`docs/security.md` §4.

## 2. Planned shape: Intent → Permission → Validation → Tool → Result → Audit

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

## 3. Autonomy levels (master spec §8) — modeled, not enforced yet

`Organization` will carry a per-workflow autonomy level (0 Manual .. 4 Finance
Automation). Not implemented in Phase 1; noted here so the eventual column
(`OrganizationAutomationSetting`) is understood to key off `(organizationId,
workflowType)`, not a single global switch — different workflows (bank
reconciliation vs. supplier payments vs. payroll) will carry different
autonomy levels per master spec §8's examples.

## 4. Specialist agents (master spec §9) — not built in Phase 1

Bookkeeping, AR, AP, Payroll, Tax & Compliance, and FP&A agents are Phase 6+
work, coordinated by an AI Financial Controller. Each will be a thin
LLM-driven planner over the same domain services; none gets bespoke data
access.

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
