# 0005 — Single Next.js app, not a monorepo, for Phase 1

## Status
Accepted; revisit when a second runtime (worker) is actually needed.

## Context
Master spec §84 requires UI, domain, persistence, integrations, AI, and
accounting logic to be properly separated. That's a layering requirement,
not necessarily a package-boundary requirement. Master spec §83 also says
"do not introduce packages without justification."

## Decision
Phase 1 is one Next.js application with internal layering by directory
(`src/app` UI, `src/domain` business logic, `src/db` persistence) rather
than a turborepo/pnpm-workspace split into `@money-matters/domain`,
`@money-matters/db`, etc. as separate packages.

## Alternatives considered
- **Monorepo with separate packages now** — the "correct-looking" enterprise
  structure, but there is no second consumer of `domain`/`db` yet (no
  background worker, no separate API service) to justify the build/publish
  overhead. Revisit the moment Phase 2's bank-feed ingestion needs a
  standalone worker process — at that point extracting `src/domain` into a
  shared package has a concrete second caller.

## Consequences
- Import boundaries between layers are enforced by ESLint
  (`no-restricted-imports`: `src/app/**` may import `src/domain/**` and
  `src/components/**`; `src/domain/**` may not import from `src/app/**` or
  Next.js-specific modules; `src/db/**` is only imported from
  `src/domain/**`), which gives the same discipline as package boundaries
  without the tooling overhead, until a real second runtime needs the split.
