# AI Agents (architecture; the AI Financial Controller foundation shipped in Phase 6 Slice 1, autonomy levels + write tools + specialist agents in Slice 2, the full 0-4 autonomy slider + whitelisted auto-execution in Slice 3)

§3 and §4 below describe what shipped in Phase 6 Slice 2: an org-level
autonomy setting that gates three write-capable (but never-posting)
Controller tools, and four specialist agent modes built as scoped tool
subsets over the same conversational loop. §3b describes Slice 3's
extension of that setting into the real five-level dial master spec §8
describes, where Levels 3-4 let the AI auto-EXECUTE a narrow,
organization-whitelisted set of actions with no per-instance confirmation
click. The AI Financial Controller itself — the read-only foundation these
sit on top of — shipped in Phase 6 Slice 1; see §0c for that design, §0d
below for Slice 2's additions to it, and §0e for Slice 3's. The onboarding
wizard's chart-of-accounts recommender (§0) is the first real AI
integration in the codebase, shipped ahead of Phase 6 as a small,
tightly-scoped exception — see §0 for why it doesn't violate the rest of
this document.

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

## 0d. Sixth integration: write-capable tools, the autonomy gate, and specialist agents (Phase 6 Slice 2)

Slice 1 was deliberately all-reads. Master spec §8 and §87.4 treat an AI
crossing into "something gets written" as a real line, not an
implementation detail, so Slice 2 draws that line as structurally as §0c's
permission discipline draws the "AI never sees more than the actor it acts
for" line:

**The autonomy setting (`src/domain/ai-controller/autonomy.ts`).**
`organizations.ai_autonomy_level` is a plain integer column (0 by default),
read/written through `AutonomySettingsService`. Only Levels 0-2 of master
spec §8's five are implemented — `setLevel` throws
`InvalidAutonomyLevelError` for 3 or 4 rather than silently storing a value
nothing honors. Levels 0 (Manual) and 1 (Suggest) are functionally
identical today: both mean "the Controller may only inform/suggest," which
was already Slice 1's only behavior, now an explicit, chosen value instead
of the only possible one. Level 2 (Prepare) is the one that matters
functionally: it is the only level at which a write-capable tool exists in
the model's tool list at all. `setLevel` requires `organization:manage`
(OWNER/ADMINISTRATOR only, per `roles.ts`) — reaching Level 2 is an
explicit opt-in a human with real authority over the organization makes on
the Settings page, never a default and never something the AI can do to
itself.

**The gate is on tool-list construction, not on tool execution.**
`FinancialControllerService.ask` calls `AutonomySettingsService.getLevel`
*before* building any tools, and only calls `buildWriteTools()` at all when
the level is >= 2 — a Level 0/1 organization's `tools` array handed to
Claude's API literally never contains `prepare_draft_invoice`,
`prepare_draft_bill`, or `prepare_draft_journal_entry`. This is the same
"never offer, don't just refuse" discipline the fuzzy-reconciliation
integration (§0a) and NL reporting (§0b) apply to data visibility, applied
here to capability visibility — proven in
`src/tests/unit/ai-controller/autonomy-gating.test.ts` by inspecting the
actual `tools` array passed to the (mocked) Anthropic call at each level.

**Prepare, never create — the proposal/confirmation split
(`src/domain/ai-controller/draft-proposal-service.ts`,
`write-tools.ts`).** Every write-capable tool follows §0c's exact wrapper
pattern (thin delegation, the real `Actor`, `guarded()`'s permission-refusal
handling) with one structural addition: **a successful tool call never
writes an invoice, bill, or journal-entry row.** It:

1. Asserts the real permission up front (`customer_invoice:manage` /
   `supplier_bill:manage` / `journal:post` — the same permission the
   underlying `InvoiceService.create`/`BillService.create`/
   `PostingService.createDraft` call enforces again at step 4, never a
   looser or different check).
2. Resolves the model's free-text request (a customer/supplier name, an
   account name) against **real** organization records — `ContactService.list`/
   `AccountService.list` — never trusting an id the model merely claims.
   An unmatched or ambiguous name is a hard failure asking for
   clarification, the same "only ever trust what was actually in the list
   handed to the model" discipline §0a's candidate-id matching and §0b's
   dimension matching both established.
3. Stores the fully-resolved creation payload (real contact id, real
   account ids, computed totals via the same `calculateInvoiceTotals`/
   `calculateBillTotals` pure functions the real UI form uses) as a PENDING
   row in `ai_draft_proposals`, along with a smaller human-readable
   `preview` the chat UI renders as a "Create this draft?" card. This row's
   insert is itself audited (`ai_controller.draft_proposed`, `actorType:
   "AI"`) — proposing is a real event even though nothing financial moved.
4. Returns the proposal's id/preview as part of the tool's result. The
   model is told (system prompt + the tool's own `summary` text) that
   nothing has been created yet and that it must tell the user a draft was
   *prepared*, never that it was *created* or *entered*.

**Only `AIDraftProposalService.confirm`, triggered by a separate, explicit
user click in the chat UI (`confirm-draft-proposal-action.ts`'s own server
action — a different one from the conversation turn's own
`askControllerAction`), ever reaches
`InvoiceService.create`/`BillService.create`/`PostingService.createDraft`.**
It re-checks the org's autonomy level (in case it was lowered between
proposal and confirmation), loads the PENDING proposal, and calls the real
domain-service method under the real, authenticated confirming actor — the
same `assertPermission` call a human using the Sales/Purchases/Journal UI
directly would hit. A restricted-role user who is shown someone else's
proposal (e.g. forwarded a link) is refused at this real call, exactly as
the UI would refuse them, even though the PENDING row itself was readable.
On success, the proposal is marked CONFIRMED with `confirmedByUserId` and
`resultEntityId`, and a second audit row (`ai_controller.draft_confirmed`,
`actorType: "HUMAN"`, metadata naming the original proposer and the
confirming user) ties the human-authored DRAFT invoice/bill/journal entry
(already audited as `HUMAN` by `InvoiceService.create` etc. itself) back to
the AI proposal that produced it — master spec §44's "for AI actions also
store: agent, model, ..., proposed action, approver, outcome," both halves
recorded, neither one overwriting or hiding the other.

This is proven against the real test database in
`src/tests/integration/ai-controller/write-tools.test.ts` (every tool's
resolution/permission/balance behavior, and that a tool call alone creates
zero invoice/bill/journal-entry rows) and
`src/tests/integration/ai-controller/draft-proposal-flow.test.ts` (the full
conversation → proposal → separate confirmation → real DRAFT invoice round
trip, a Level 0 org never offering the tool for the identical request, and
a restricted-role confirmer being refused at the real creation step).

**Specialist agents as scoped modes
(`src/domain/ai-controller/specialist-agents.ts`), not a new framework.**
Per §4 below (now implemented, not just planned): Bookkeeping, AR, AP, and
FP&A are each a fixed `{ readToolNames, writeToolNames, systemPromptAddendum }`
record. `FinancialControllerService.ask` takes an `agentMode` parameter
(default `"GENERAL"`, the full Slice 1 tool set) and filters
`buildControllerTools()`'s and `buildWriteTools()`'s output down to that
mode's named subset — it only ever narrows what a plain Controller
conversation could already do, never widens it, and reuses every bit of
§0c's loop/guard/audit machinery unmodified. Payroll and Tax & Compliance
are **not** built as modes — see §4 for why.

## 0e. Seventh integration: whitelisted auto-execution — the real 0-4 autonomy dial (Phase 6 Slice 3)

This is a deliberate, user-authorized expansion of AI autonomy beyond
Slice 2's scope. The user explicitly asked for "levels of autonomy, the
user can select how much on a sliding scale, that makes it the user's
responsibility," and confirmed the boundary: "it will be most things, just
not critical things as mentioned" — critical meaning master spec §8's own
carve-out (large payments, bank-detail changes, payroll changes, tax
submissions, unusual journals, period closes), which stays human-gated at
**every** autonomy level with no exception. See §3b below for the full
design this section summarizes.

**The structural shape mirrors every prior integration in this document**:
a closed, hand-curated set of what the AI may ever do
(`AUTO_APPROVABLE_ACTION_TYPES` in `auto-execution-policy.ts`), each member
a thin wrapper around an already-existing, already-human-triggered,
already-reversible domain-service call — never new business logic, never a
second ledger-writing code path. What's new relative to Slice 2 is not a
new kind of trust in the AI's judgment; it's removing a per-instance human
click for a category the organization pre-approved in advance, exactly
master spec §76's "learn organisation-specific patterns only through
controlled configuration."

**Two gates, not one, checked fresh every time**: `isAutoExecutionApproved`
requires both the org's autonomy level (>= 3) AND an explicit per-action-type
whitelist row, read from Postgres on every single check — never cached
across a request, a session, or even within one multi-action-type run.
This is what makes turning the dial to Level 3/4 alone do nothing (the
whitelist starts empty, always), and what makes the emergency stop
(`AutonomySettingsService.emergencyStop`) take effect on the very next
check with no invalidation step required.

**The excluded category is enforced by what the allowlist does NOT
contain, in two independent places**: the Postgres enum column
(`ai_auto_execution_action_type`) and a zod schema in application code
both only ever accept the three real action types — so neither a raw SQL
write nor an application-level caller can smuggle in
`SUPPLIER_PAYMENT_CREATE`, `BANK_ACCOUNT_DETAIL_CHANGE`,
`PAYROLL_ANY`/`TAX_SUBMISSION_ANY` (no such domains exist yet, so there is
nothing for even the model to pretend to automate), `JOURNAL_ENTRY_UNUSUAL`
(`prepare_draft_journal_entry` stays confirmation-gated at every level —
never promoted, because there is no `JOURNAL_ENTRY` entry in the
allowlist), or `FISCAL_PERIOD_CLOSE` (the close/lock workflow now exists —
Phase 9 Slice 3 — as a human-only feature; nothing here creates a path
toward it, see §0g). `PaymentRunService`'s own segregation-of-duties check
(§8's "large payments... always require authorisation") is untouched and
is never routed around — `AutoExecutionService` never calls it at all,
proven by a real-database test that a Level 4 org with everything else
whitelisted still gets `SelfApprovalNotAllowedError` on a self-approval
attempt, identically to Level 0.

**Honest about Level 3 vs. 4**: both share the identical mechanism and,
today, the identical three-item allowlist. This document does not invent a
distinction that isn't real — see §3b for why, and what would change it.

**Human override (master spec §77)**: every auto-executed action is
recorded in `ai_auto_executions` (visibly flagged in the invoice/bill
lists and the Daily Finance Brief, not only in the audit log), trivially
undoable (`InvoiceService.deleteDraft`/`BillService.deleteDraft` for a
still-DRAFT auto-generated invoice/bill, a new
`ReconciliationService.unmatch` for an auto-confirmed bank match — never a
destructive edit, and `PostingService.reverseEntry` remains the only way
to undo anything actually posted, which auto-execution in this slice never
does), and the whole mechanism is pausable via a real, reachable emergency
stop separate from the normal settings form.

## 0f. Eighth integration: the read-only `cash_forecast` tool and forecast/scenario commentary (Phase 9 Slice 2)

Two small additions, both following patterns already established above — no
new autonomy machinery.

**`cash_forecast` (a Financial Controller read tool).** A thin wrapper around
`CashForecastService.generate` (master spec §38), declared with
`permission: "forecast:read"` and executed through the same `guarded()`
refusal path as every other tool, so a role without the permission gets the
structured "Access denied ... forecast:read" refusal and no citation —
proven with real restricted-role actors against the real database in
`src/tests/integration/forecasting/cash-forecast-ai.test.ts`. It accepts a
`horizon` (7D/30D/60D/90D/12M) and an optional `asOfDate`, both
re-validated by zod before running, so a user can ask "when might we run low
on cash?" and get a real, cited answer (the citation links to the Cash
Forecast page). What it returns is the §38 distinction **kept structural, so
the assistant can't blur it either**: the text handed to the model has two
separately-headed projections — `KNOWN COMMITMENTS ONLY (grounded in
invoices, bills, approved payment runs, scheduled recurring templates)` and
`INCLUDING STATISTICAL PROJECTIONS (ESTIMATES from simple historical
averages, NOT certain)` — each with its own end balance and low point, the
low-cash warning with its real date, the largest lines of each kind (a
statistical line says what average it came from and over how many settled
invoices), and a separate paragraph for known amounts with no determinable
date. The tool description and the FP&A system prompt both instruct the model
to say which projection a statement is about.

**Payroll sensitivity carries through.** Payroll-derived lines are gated on
`payrun:read` inside `CashForecastService`, not in the tool: a role that can
read forecasts but not pay runs (MANAGER, READ_ONLY) gets a complete forecast
with payroll lines omitted and a one-line notice saying so, and none of the
payroll figures or even payroll wording appears in the tool result (asserted
in the test above).

**What is deliberately NOT here.** There is no scenario-creating (or any
scenario) tool: creating a scenario is a write, and a write-capable tool
would need the whole Phase 6 Slice 2/3 proposal-and-confirmation machinery —
out of scope for this slice; scenarios are created by humans in the UI. A test
asserts no registered tool name mentions scenarios.

**Optional commentary (`ForecastCommentaryService`).** The same lightweight
pattern as the Management Report Pack and Daily Brief commentary: given only
already-computed figures (`forecastFacts`/`scenarioFacts` build them — KNOWN
and STATISTICAL under separate labels; scenario cases described as
assumptions), instructed never to calculate or introduce a number, 15 s
timeout, and `null` — the page simply omits the card — when there is no
`ANTHROPIC_API_KEY` or the call fails. It is opt-in per page load
(`?commentary=1`) so a model call doesn't run on every render. It is never a
source of figures. As with every AI feature in this codebase, the real
Anthropic API is only exercised through a mocked SDK in tests.

## 0f-bis. The read-only `bas_summary` tool (Phase 8 Slice 2)

A Financial Controller read tool (`bas:read`, permission parity: a role without it is refused exactly as the BAS page is)
that returns the labels, net GST, reconciliation variance, unclassified counts and warnings of the most recent prepared BAS
worksheet (or one by id) as plain text for the model to EXPLAIN. It cannot create, change, finalise or lodge anything - there
is no BAS write tool, `bas:finalise` is human-only (an AI actor is refused even with an OWNER role), and the tool text tells
the model every figure must come from the tool and that the worksheet is prepared for registered tax agent / BAS agent review
and NOT lodged with the ATO. Payroll remains structurally excluded from auto-execution; no payroll tool exists.

## 0g. Ninth integration: the read-only `close_status` tool and checklist commentary (Phase 9 Slice 3)

Month-end close is a **permanently human-gated critical action** (master spec
§8/§41/§77): `FISCAL_PERIOD_CLOSE` is in the structurally-excluded list above,
and Slice 3 builds the thing that exclusion was written for without giving the AI
any path to it.

**`close_status` (a Financial Controller read tool).** A thin wrapper around
`CloseChecklistService.compute`, declared with `permission:
"close_checklist:read"` and run through the same `guarded()` refusal path, so a
role without the permission gets the structured "Access denied ...
close_checklist:read" refusal and no citation (proven with real restricted-role
actors). It takes an optional `month` (`YYYY-MM`, default the previous month),
validated by zod, and returns the live checklist as text: the percentage and its
formula, BLOCKING items, ATTENTION items, items awaiting a human sign-off, items
**signed off by a person (explicitly "not system-verified")**, items verified by
the system, and not-applicable items. Payroll items are omitted — and the text
says items are hidden — for a role lacking `payrun:read`. It is offered to the
general Controller and the Bookkeeping specialist. The citation links to
`/accounting/close/<month>`.

**No write path.** There is no tool that closes, locks, reopens or signs off, and
a model that asks for one gets "Unknown tool" and nothing changes (an
end-to-end test with a mocked model proves it). Tests assert across the whole
read+write tool registry that the only name touching close/lock/period is
`close_status`, that no tool declares a `period:*` permission, that the
auto-execution allowlist contains nothing period-related and refuses to
whitelist `FISCAL_PERIOD_CLOSE`/`FISCAL_PERIOD_REOPEN`/`PERIOD_LOCK_OVERRIDE` at
Level 4, and that even an actor typed `AI`/`SYSTEM` carrying an OWNER role is
refused by `PeriodCloseService`/`PeriodLockService`.

**Optional "what remains" commentary (`CloseCommentaryService`).** The same
lightweight pattern as the management pack, daily brief and forecast commentary:
handed only the already-computed checklist facts (`checklistFacts`, shared with
the tool, which keep system-verified and human-signed items under separate
labels), told never to calculate or introduce a figure, never to describe a
person's sign-off as system verification, and that it cannot close or change
anything; offered no tools; 15 s timeout; `null` (the card is simply omitted)
without an `ANTHROPIC_API_KEY` or on failure. It is opt-in per page load
(`?summary=1`). As elsewhere, the real Anthropic API is only exercised through a
mocked SDK in tests.

## 0h. Tenth integration: the read-only `consolidated_report` tool (Phase 9 Slice 4)

Master spec §30: "Never allow data from unauthorised entities to leak through AI
retrieval." This is the first tool whose answer can span organizations, so it is
built so that the only way it can run is the existing permission-parity path,
once per entity.

**`consolidated_report` (a Financial Controller read tool).** Arguments: a report
kind (`PROFIT_AND_LOSS`, `BALANCE_SHEET`, `CASH`), an optional group **name** (the
user's own groups; it asks which one when several exist and none is named), and a
period / as-of date. There is deliberately **no organization id, account id or
group id argument** — the model cannot name an entity. It first applies the same
`financial_report:read` gate as every other report tool in the organization being
chatted in, then calls `ConsolidationService`, which for each group entity — in
sequence, one connection at a time — builds an `Actor` from the user's real
membership role **in that entity** and lets `ReportingService` (or the cash
position) enforce its permission. An entity with no membership is never queried;
one without the permission is excluded. The result text (`consolidatedSummary`)
carries the exclusion notice ("N entities excluded — no access"), tells the model
to repeat it and never guess at excluded entities, names only the included
entities, and flags unmatched intercompany balances and unmapped accounts rather
than presenting totals as final. Mixed base currencies return the specific refusal.
It is offered to the general Controller (read tools are all offered there);
citations name the group and period like every other tool's.

**No write path, and the autonomy exclusions are untouched.** There is no tool to
create or change a group, mapping, designation or adjustment; a model that asks
for one gets "Unknown tool". The write-tool registry still contains only
`prepare_draft_*` tools, and nothing consolidation-related is in the
auto-execution allowlist (both asserted).

**The leak test (mandatory, `src/tests/integration/consolidation/ai-tool.test.ts`).**
With a real restricted-role actor in one entity (EMPLOYEE — no
`financial_report:read`) and no membership in another, the tool's output for each
of cash / balance sheet / P&L contains no figure, name, slug or id of either
entity (the distinctive 99,999.00 and 7,000.00 balances are asserted absent); a
user restricted everywhere except one entity sees only that entity and a
"3 entities excluded" count; and an end-to-end run with a mocked Anthropic SDK
captures every request payload sent to the model plus the final answer and
asserts none of it contains unauthorised data. As elsewhere the real Anthropic
API is only exercised through the mocked SDK.

## 0i. Eleventh integration: the read-only `practice_overview` and `workpaper_status` tools, and workpaper commentary (Phase 9 Slice 5)

Two more read tools for an accountant who asks the Controller about their practice,
built on the same permission-parity rule as `consolidated_report` — and one level
stricter, because the data spans clients:

- **`practice_overview`** — the practice dashboard from **saved snapshots** (the model
  cannot refresh them, so it cannot cause a connection fan-out): per client the Books,
  Reconciliation, BAS/Tax (a deadline the practice typed in — never an official date),
  Payroll and Issues indicators, worst first, with the snapshot age. Arguments are only
  an optional practice **name**, a filter and a page — **no organization, client or
  account id**.
- **`workpaper_status`** — workpapers by status/client with the snapshot balance and date,
  open notes and, for at most three papers, the computed reconciliation (schedule total,
  difference, proposed adjustments, who signed). Arguments: practice name, part of a
  client name, a status.

Both first apply the chat organization's `financial_report:read` gate, then read through
`src/domain/practice/assistant-views.ts` using the person's own identity: the practice must
be one they are an ACTIVE member of (the database refuses any other); a client is included
only if they hold a real membership in it, its link is ACTIVE, and **their role there**
allows the figure (payroll reads "not visible to your role" without `payrun:read`; a
workpaper needs `financial_report:read` and `journal:read` in that client); every other
client — unreachable, pending, revoked, foreign — is reported **only as a count**
("N linked client(s) are excluded — this user has no access to them") and never named.
The result text reminds the model that figures are snapshots and that there is no BAS/GST
preparation in this system.

**No write path; autonomy and close exclusions untouched.** There is no tool to link,
assign, refresh, sign off, reopen, post or close; a model asking for one gets "Unknown
tool". The write-tool registry still holds only `prepare_draft_*` tools; nothing practice-
related is auto-approvable; period close remains human-only (all asserted).

**Optional workpaper commentary** (`WorkpaperCommentaryService`, shown on the workpaper
page only when asked for with `?summary=1`): a 3-5 sentence reading aid written from the
already-computed facts (balance, schedule total, difference, counts) with the instruction
never to calculate or introduce a figure; omitted (`null`) with no `ANTHROPIC_API_KEY` or
if the call fails; it cannot sign off or change anything.

**The leak test (mandatory, `src/tests/integration/practice/ai-tools.test.ts`).** With real
restricted-role actors — S1 as MANAGER (no `payrun:read`) or EMPLOYEE (no report
permissions) in a client, no membership in another, a client that revoked, a pending one,
and a workpaper (with a distinctive 88,888.00 balance) in a client only a colleague belongs
to — the tool output for each tool contains no name, slug, id or figure of any of them, and
an end-to-end run with a mocked Anthropic SDK captures every payload sent to the model plus
the answer and asserts the same; an attempted `sign_off_workpaper` is an unknown tool and
the workpaper stays a draft.

## 0j. The public API is not an AI surface: API keys are outside the controller's reach (Phase 10 Slice 1)

Phase 10 Slice 1 adds API keys for server integrations (`docs/api.md`, `docs/security.md` section 15). The AI Financial Controller
has **no tool that touches them**, in either direction:

- No read tool, no write tool (`prepare_*`), no specialist mode and no auto-execution allowlist entry mentions API keys, scopes or the
  API. `ApiKeyService` requires a `HUMAN` actor *and* `api_key:manage` (OWNER/ADMINISTRATOR), so an `AI`-typed actor is refused even if it
  carried the OWNER role, and a test pins the only modules that import the key service (the settings page and its actions).
- The converse also holds: an API key is itself a non-human actor (`type: "API"`), refused by every human-only check the AI is refused by
  (period close/reopen, lock overrides, sign-offs), and its effective permissions are a strict whitelist that excludes everything in the
  §3b "never auto-executable" list (supplier payments, payment runs, payroll, tax, period close). Its writes are DRAFT-only, mirroring the
  AI "prepare, a human confirms" rule: an integration prepares a draft invoice or bill, a person posts it.
- `src/tests/unit/api/ai-boundary.test.ts` asserts the controller tool registry (read and write), the specialist agent modes and the
  auto-execution allowlist contain nothing API-key related and that the AI source tree never imports the API modules.

## 0k. Webhooks and the event outbox are not an AI surface (Phase 10 Slice 2)

Phase 10 Slice 2 adds webhook subscriptions and a transactional event outbox (`docs/api.md` "Webhooks", `docs/security.md` section 16). The AI Financial Controller has **no tool that reads, creates,
changes, replays or even lists them**:

- `webhook:manage` is held by OWNER/ADMINISTRATOR only and `WebhookSubscriptionService` / `WebhookDispatchService` require a `HUMAN` actor, so an `AI`-typed actor is refused even with the OWNER role. A webhook aims the
  platform's server at a URL of someone's choosing (an SSRF-shaped capability) and holds a signing secret: both are decisions for a person.
- No read tool, write (`prepare_*`) tool, specialist mode or auto-execution allowlist entry mentions webhooks, the outbox or domain events (`src/tests/unit/webhooks/structure.test.ts`), the AI source tree never imports the
  webhook modules, and a test pins the only modules that do (the settings pages and actions). The "never auto-executable" list (supplier payments, payroll, tax, period close) is unchanged.
- The outbox is not an AI input either: events carry the same DTOs as the public API (customer, invoice, payment and bill objects) to the customer's own endpoint; nothing from the delivery log is fed to a model.
- Business events are emitted by the same domain services whoever acts, so a document the AI drafts and a person confirms emits the same event as one created by hand; the AI never decides whether an event is emitted.


## 0l. The Automation Centre and integrations are not an AI surface - and the autonomy whitelist is not duplicated (Phase 10 Slice 3)

Phase 10 Slice 3 adds **automation rules** (Settings -> Automation) and an **integration framework** (Settings -> Integrations). Design and threat model: `docs/security.md` sections 18-19.

- **Exclusions.** The AI Financial Controller has no tool that reads, creates, edits, enables, pauses or runs an automation rule, connects or tests an integration, or reads a notification. `automation:manage` and `integration:manage` are held by OWNER / ADMINISTRATOR only and every
  management service requires a `HUMAN` actor, so an `AI`-typed actor is refused even with the OWNER role. The controller registry (read and write tools), the specialist modes, the auto-execution allowlist (`AUTO_APPROVABLE_ACTION_TYPES`) and the API scope list contain nothing
  automation- or integration-related, and no `ai-controller` module imports the automation, integration or notification services (`src/tests/unit/automation/exclusions-and-identity.test.ts` and `structure.test.ts`).
- **An automation is not an AI agent, and an AI agent is not an automation.** Automations are deterministic rules over a closed vocabulary (no model is called anywhere in them). They run as actor type `AUTOMATION`, a third non-human type beside `AI` and `API`: refused by every
  human-only check, narrowed to the intersection of the rule's action and its authoriser's current role. The §3b "never auto-executable" list (large payments, bank-detail changes, payroll, tax submissions, unusual journals, period close, posting / approving / voiding) is
  **not reachable by an automation either** - those actions are not in the action enum and their permissions are outside the identity's allow-list.
- **One mechanism per behaviour.** The spec's "when bank confidence is above 99% and the rule is approved, reconcile automatically" ALREADY exists as the Phase 6 `BANK_RECONCILIATION_AUTO_MATCH` auto-approved action (section 3b), enabled per action type under Settings ->
  AI Financial Controller autonomy, with the level >= 3 gate, the emergency stop, the audit trail and undo. The Automation page shows a read-only pointer to it instead of offering a second, weaker way to do the same thing. Conversely, nothing the autonomy slice may auto-execute is
  an automation action (it posts documents and reconciles; automations never do).
- The same pause discipline applies in both places: the autonomy emergency stop takes effect on the next evaluation; so does "Pause all automations" (read uncached on every pass).

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

## 3. Autonomy levels (master spec §8) — Levels 0-2 (Phase 6 Slice 2; see §3b for 3-4, added in Slice 3)

`organizations.ai_autonomy_level` (`src/domain/ai-controller/autonomy.ts`)
is a single org-level integer, not yet the per-workflow
`(organizationId, workflowType)` key master spec §8's full vision describes
— this slice has exactly three kinds of mutating tool (invoice/bill/journal
draft preparation), all gated identically, so a single org-wide switch is
the right amount of complexity today; splitting it per workflow is
straightforward later if/when those workflows' risk profiles actually
diverge (e.g. once a supplier-payment-execution tool exists, it would
reasonably want its own, stricter gate).

- **Level 0 (Manual) / Level 1 (Suggest)** — functionally identical today:
  the Controller may only read and inform, exactly like Slice 1's only
  possible behavior. This is every organization's default; reaching a
  higher level is never automatic.
- **Level 2 (Prepare)** — additionally offers `prepare_draft_invoice`,
  `prepare_draft_bill`, and `prepare_draft_journal_entry` to the model (see
  §0d). The AI still never creates, posts, approves, or confirms anything
  itself at Level 2 or any other level — "prepare" names the ceiling of
  what Level 2 unlocks, not a promise that the AI acts unsupervised within
  it. An OWNER/ADMINISTRATOR must explicitly opt in on the Settings page.
- **Level 3 (Auto, low-risk) and Level 4 (Finance automation)** — see §3b
  immediately below for the full design shipped in Phase 6 Slice 3. In
  short: the AI may auto-execute a narrow, explicitly organization-
  whitelisted set of action types with no per-instance confirmation click,
  but the level alone does nothing — an explicit whitelist entry is always
  also required — and master spec §8's own "large payments, bank-detail
  changes, payroll changes, tax submissions, unusual journals, period
  closes always require authorisation" carve-out is enforced structurally
  at every level, with no exception for 3 or 4.

## 3b. Levels 3-4: whitelisted auto-execution (Phase 6 Slice 3)

This is the real build-out of what §3 above used to defer. It is a
deliberate, user-authorized expansion of AI autonomy — see §0e above for
the user's own framing of the request and the safety boundary they
confirmed — built carefully rather than loosely, per that same
conversation's instruction.

**The whitelist, not the level number, is what actually gates anything**
(`src/domain/ai-controller/auto-execution-policy.ts`). `ai_auto_approved_actions`
is a per-organization, per-action-type table; a row's mere existence means
that action type is auto-approved. Turning the dial to Level 3 or 4 inserts
**zero** rows here — an OWNER/ADMINISTRATOR must separately, explicitly
enable each action type, exactly the same `organization:manage`-gated
opt-in discipline `AutonomySettingsService.setLevel` already established
for reaching Level 2. `isAutoExecutionApproved(organizationId, actionType)`
is the single choke point every auto-execution attempt passes through, and
it requires BOTH conditions, read fresh from Postgres on every call — see
"no caching, ever" below.

**The closed allowlist (master spec §76's "controlled configuration")**:
`AUTO_APPROVABLE_ACTION_TYPES` has exactly three members, each one an
existing, already-safe, already-human-triggered mechanism made reversible
by construction:

- `RECURRING_INVOICE_AUTO_GENERATE` / `RECURRING_BILL_AUTO_GENERATE` —
  auto-triggers `RecurringInvoiceService.generateDue`/
  `RecurringBillService.generateDue` (Phase 3/4 Slice 2), the exact same
  call a human's "Generate due invoices/bills" button already makes. The
  AI's job here is narrower than full autonomy: "trigger the thing a human
  would have clicked," not a new kind of judgment. The result is a plain
  DRAFT invoice/bill — nothing is approved, posted, or sent.
- `BANK_RECONCILIATION_AUTO_MATCH` — auto-confirms ONLY a deterministic,
  same-day, exact-amount candidate from `ReconciliationService.
  findCandidateMatches` (confidence exactly 1.0), via the exact same
  `confirmMatch` a human's "Confirm match" click already calls.
  **Deliberately, explicitly never auto-confirms a `FuzzyReconciliationService`
  suggestion**, however high its self-reported confidence — a probabilistic
  AI judgment is not the "previously human-approved category" §76
  describes; fuzzy suggestions stay propose-only at every autonomy level,
  including 4. This is the one place in this slice where "higher confidence
  number" and "safe to auto-execute" are explicitly NOT treated as the same
  thing.

Both the Postgres enum column backing this table and a zod schema in
`auto-execution-policy.ts` independently enforce this closed set —
`AutoApprovedActionsService.setEnabled` refuses anything else
(`InvalidAutoApprovedActionTypeError`) structurally, not merely by omitting
it from a settings dropdown. `src/tests/unit/ai-controller/
auto-execution-policy.test.ts` proves the allowlist and a documented
excluded-category example list (`SUPPLIER_PAYMENT_CREATE`,
`PAYMENT_RUN_APPROVE`, `BANK_ACCOUNT_DETAIL_CHANGE`, `PAYROLL_ANY`,
`TAX_SUBMISSION_ANY`, `JOURNAL_ENTRY_UNUSUAL`, `FISCAL_PERIOD_CLOSE`) are
disjoint, with no database involved — this is a property of the code, not
of what happens to be configured in any one organization.

**What stays untouched, on purpose**: `PaymentRunService`'s own
segregation-of-duties check (`SelfApprovalNotAllowedError`) is master spec
§8's "large payments... always require authorisation" already enforced,
independently, before this slice existed. `AutoExecutionService` never
calls `PaymentRunService` at all — there is no code path, gated or
otherwise, connecting autonomy levels to payment approval.
`prepare_draft_journal_entry` (Slice 2) is never promoted to
auto-execute — there is no `JOURNAL_ENTRY` member in the allowlist, so an
"unusual" manual adjustment stays confirmation-gated at every level,
structurally. Payroll, tax, bank-account-detail changes, and fiscal period
closes have no auto-execution path: the allowlist is closed and contains none
of them. (Payroll and the period close/lock workflow have since been built as
human-only features — Phase 8 Slice 1 and Phase 9 Slice 3 — and remain
unreachable from every AI path; see §0g and `docs/security.md` §11.)

**Honest Level 3 vs. 4**: the task that commissioned this slice explicitly
asked for the real distinction if one exists, or a plain admission if it
doesn't, rather than a fabricated one. Today, Levels 3 and 4 share the
identical mechanism (the same whitelist, the same `isAutoExecutionApproved`
check) and the identical three-item allowlist — there is no second,
broader-but-still-safe action type this codebase has today to reserve for
Level 4 alone. A candidate the task itself suggested — auto-promoting an
auto-drafted invoice/bill into a "ready for review" queue at Level 4 only —
was deliberately not built: no such status exists in `invoice_status`/
`bill_status` today, and inventing one purely to manufacture a 3-vs-4
difference would be exactly the shallow, cosmetic distinction the task
asked not to produce. This mirrors Slice 2's own precedent for Levels 0/1
("functionally identical today, kept as distinct values because master
spec §8 names them distinctly") — the same honest pattern, one level pair
later. A real Level-4-only action type becomes possible once a second
low-risk, reversible, already-human-triggered mechanism exists to reserve
for it.

**No caching, ever — this is what makes the emergency stop work.**
`isAutoExecutionApproved` queries the organization's current autonomy level
and the current whitelist row from Postgres on every single call; nothing
in `AutoExecutionService` or anywhere upstream holds on to a previous
answer. `AutonomySettingsService.emergencyStop` (master spec §77's
"pause/override," a distinct control from the normal level-picker form —
see the Settings page) is not a special code path at all: it is
`setLevel(actor, 0)` with its own audit action name, and its "immediacy"
is a direct consequence of there being no cache to invalidate — the very
next `isAutoExecutionApproved` call anywhere in the app already sees Level
0. Proven with a real-database test
(`src/tests/integration/ai-controller/auto-execution.test.ts`): Level 4
plus a whitelist entry auto-executes once, the emergency stop is
triggered, new due work is created afterward, and the next
`runPendingAutoExecutions` call executes nothing — with the whitelist row
itself still present in the database, proving it's the level being
re-checked fresh, not the whitelist having been wiped.

**Human override machinery (master spec §77) for whatever gets
auto-executed**: a new `ai_auto_executions` table records every
auto-executed action with master spec §44's audit fields (agent, model —
null for the two deterministic recurring-generation action types, which
trigger existing business logic rather than an LLM inference — confidence,
proposed action, and an `approver` field that truthfully records
"auto-approved under org policy (autonomy level N, action type X
whitelisted)," never a fabricated human approver). This is what the
invoice and bill list pages query to render a visible "AI auto" badge
(not buried in an audit log nobody reads), and what the Daily Finance
Brief's callout ("The AI Financial Controller auto-executed N whitelisted
action(s) in the last 24 hours...") surfaces. Every auto-executed action is
trivially undoable
(`AutoExecutionService.undo`): `InvoiceService.deleteDraft`/
`BillService.deleteDraft` for a still-DRAFT auto-generated invoice/bill
(nothing was posted, so deleting a draft is the correct, non-destructive
undo exactly like any other draft), and a new `ReconciliationService.unmatch`
for an auto-confirmed bank match (reverts the link only — it refuses on a
transaction that was instead reconciled by posting a brand-new journal
entry, since undoing a posted entry must go through
`PostingService.reverseEntry`, never a status flip; auto-execution in this
slice never takes that posting path in the first place, so this guard is
never actually exercised by anything this slice does, only by misuse).

**Who triggers a check, given no job-queue infrastructure exists** (the
same documented gap since Phase 2 Slice 2, carried forward through every
"generate due"/"on-demand" feature in this codebase):
`FinancialControllerService.ask` runs `AutoExecutionService.
runPendingAutoExecutions` as a best-effort first step on every conversation
turn (never blocking the user's actual question if it fails), and the
Settings page has a dedicated "Run automated actions now" button. Both are
the same honest "on-demand precursor to real scheduling" framing this
codebase has used since `RecurringInvoiceService.generateDue` itself.

## 4. Specialist agents (master spec §9) — Bookkeeping/AR/AP/FP&A built as scoped modes; Payroll/Tax deliberately deferred (Phase 6 Slice 2)

`src/domain/ai-controller/specialist-agents.ts` implements each specialist
as a named, narrower *mode* over the one Controller loop built in Slice 1
— exactly the "thin planner over the same domain services, no bespoke data
access" shape this section originally sketched, concretely: a fixed
`{ readToolNames, writeToolNames, systemPromptAddendum }` record per mode,
never a second orchestration framework, a second permission system, or a
separate conversation loop. Selecting a mode (via the chat UI's mode picker,
which calls `FinancialControllerService.ask(..., agentMode)`) only narrows
`buildControllerTools()`'s/`buildWriteTools()`'s output to that mode's named
subset and appends a short system-prompt addendum — it can never grant a
tool a plain `"GENERAL"` conversation couldn't already use, and it reuses
§0c's loop/guard/citation/audit machinery completely unmodified.

- **Bookkeeping** — `trial_balance`, `find_invoice`, `find_bill`,
  `find_expense_claim`, `run_report`, plus `prepare_draft_journal_entry` at
  Level 2 (the "unusual manual adjustment" case). No bank-transaction
  posting/categorization tool exists in this slice's write-tool list (only
  invoice/bill/journal-entry preparation), so Bookkeeping has no additional
  write capability beyond the journal entry — it is mostly a system-prompt
  specialization today, honestly reflecting what's actually built rather
  than implying a reconciliation-automation capability that isn't there.
- **AR** — `aged_receivables`, `find_invoice`, `run_report`, plus
  `prepare_draft_invoice` at Level 2.
- **AP** — `aged_payables`, `find_bill`, `run_report`, plus
  `prepare_draft_bill` at Level 2.
- **FP&A** — `profit_and_loss`, `balance_sheet`, `trial_balance`,
  `run_report`, and (Phase 9 Slice 2) `cash_forecast`. Read-only by design
  (no write tool at any level) — this is profitability/trend/KPI analysis
  over reports that already exist. Its system prompt now tells the model
  that known and statistical projections are two separate things and to say
  which it means, and still has it say plainly that it has no budget or
  what-if-scenario tool (those are UI features) rather than inventing a
  comparison figure.
- **Payroll and Tax & Compliance are deliberately NOT built**, not even as
  a mode with zero tools. There is no payroll domain (employee records, pay
  runs, PAYG/super) and no tax-filing/BAS domain anywhere in this codebase
  yet — Phase 8 hasn't started. An agent "for" either would have no real
  tool behind it, which is exactly the shallow-stub this codebase's
  roadmap (§82/§85) refuses to ship. `DEFERRED_AGENTS` in
  `specialist-agents.ts` names both, with the reason, so the chat UI shows
  them as visibly disabled options rather than omitting them with no
  explanation (master spec §6's "a why, shown not hidden," applied to what
  isn't built as much as to what is).

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
