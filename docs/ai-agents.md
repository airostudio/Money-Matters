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
