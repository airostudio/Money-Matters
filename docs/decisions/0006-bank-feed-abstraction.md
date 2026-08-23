# 0006 — Bank feed abstraction: manual import first, live providers behind an interface

## Status
Accepted for Phase 2's first vertical slice (bank import + reconciliation +
bank rules). Live provider integration is a follow-up slice, not yet built.

## Context
Master spec Phase 2 asks for a "bank feed provider abstraction" plus
CSV/OFX/QIF import, AI-assisted reconciliation with explanations, and bank
rules. A live feed (Basiq for AU open banking, Plaid/TrueLayer elsewhere)
needs a real vendor account and API credentials that only the product owner
can provision — the same constraint that shaped how Supabase credentials
were handled (`docs/security.md`, the `MM_APP_DB_PASSWORD` design): this
codebase never invents a placeholder credential or points at a vendor
account it doesn't have.

Master spec §82 also requires vertical slices, not superficial features
across the board. A `BankFeedProvider` interface with only a live vendor
behind it would be unusable — and untestable — until that vendor account
exists.

## Decision
Ship the vendor-agnostic parts first, as a complete, usable slice:

- `bank_accounts`/`bank_transactions`/`bank_import_batches`/`bank_rules`
  tables model a bank account's data the same way regardless of where it
  came from. `bankAccounts.provider` (`bank_feed_provider` enum, currently
  `MANUAL` only) and `externalAccountId` exist specifically so a live
  provider is a new enum value and a populated column, not a schema
  migration that touches existing rows.
- `src/domain/banking/parsers/{csv,ofx,qif}.ts` turn a statement export into
  the same `ParsedStatementRow[]` shape a live feed's transaction list would
  produce. `bank-import-service.ts` (the "provider abstraction" in practice)
  never branches on where rows came from past that point.
- Every row gets a stable `externalId` — the provider's own id when one
  exists (OFX `FITID`), otherwise a content hash (`external-id.ts`) — so
  re-importing the same statement, or a live feed re-syncing an overlapping
  date range later, is idempotent by construction rather than by a
  best-effort duplicate check.
- Reconciliation matching (`reconciliation-service.ts`) is deterministic:
  exact-amount journal lines on the bank account's GL account, within a date
  window, ranked by date proximity, each with a plain-language explanation
  string. This is the "AI reconciliation matching + explanations"
  requirement's *foundation*, deliberately not its only layer — see
  "AI reconciliation" below.

Live provider wiring (Basiq, most likely, given the seed data and default
`country: "AU"`) is deferred until a real account exists. When it does, the
work is additive: a new `BankFeedProvider` implementation that produces
`ParsedStatementRow[]` from an API poll/webhook instead of an uploaded file,
feeding the same `BankImportService.importStatement` pipeline — not a
rewrite of the import or reconciliation logic.

## Why deterministic matching, not a model call, for Phase 2
"AI reconciliation matching + explanations" could mean an LLM ranks
candidates and writes free-text reasons. That was deliberately not built
yet:

- A wrong deterministic match is loud (the amount literally doesn't equal,
  a human notices immediately reading the explanation). A wrong AI-ranked
  match with a fluent explanation is the more dangerous failure mode for
  money — plausible-sounding and easy to rubber-stamp.
- Every explanation `findCandidateMatches` returns is checkable against the
  data by inspection ("amount matches exactly; date is 2 days away") rather
  than trusted on the model's say-so.
- Nothing here forecloses a model-assisted layer later — a fuzzy pass over
  transactions with *no* exact-amount candidate (matching by description
  similarity to a contact/payee, using the AI layer planned for Phase 6) is
  a natural addition on top of this, called out as a follow-up in
  `reconciliation-service.ts`'s own doc comment. It would generate more
  candidates for a human to confirm through the same `confirmMatch` path,
  never post a journal entry unattended — consistent with the master
  spec's "never let AI bypass permissions" constraint.

## Alternatives considered
- **Build the live Basiq integration now, mocked for tests.** Rejected: a
  mocked vendor integration tests the mock, not the vendor's actual API
  shape, and produces code that can't be verified end-to-end until real
  credentials exist — the exact trap `docs/decisions/0001-database-orm.md`
  and the Supabase connection work were written to avoid repeating.
- **A generic `BankFeedProvider` interface with only `MANUAL` implementing
  it today.** Considered and partly adopted in spirit — the schema and
  `ParsedStatementRow` shape *are* that abstraction — but no interface type
  was introduced with a single implementation, since a one-member interface
  documents an aspiration more than it constrains anything; the next
  provider's shape will be informed by the vendor's actual API rather than
  guessed now.

## Consequences
- No Phase 2 code needs to change to add a live feed later beyond a new
  parser/poller producing `ParsedStatementRow[]` and a new
  `bank_feed_provider` enum value (`drizzle/0005_*` when that lands).
- Every transaction in the system today came from a file a person uploaded,
  which is the correct trust level for Phase 2: nothing auto-imports or
  auto-posts without a human choosing to import a specific file and, for a
  new journal entry, choosing its categorization.
- `src/domain/banking/**` still imports nothing from `src/app/**`
  (`docs/decisions/0005-single-app-not-monorepo.md`'s layering holds); when
  a live feed eventually needs background polling outside a request/response
  cycle, that ADR's "revisit when a second runtime is actually needed" is
  the trigger, not this one.
