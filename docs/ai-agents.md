# AI Agents (architecture; implementation begins Phase 6)

Phase 1 ships no AI functionality. This document records the architecture
decisions made *now* so that Phase 1's domain layer doesn't have to be
reshaped when the AI Financial Controller (master spec §7-9) is built.

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
