# Contributing

Read [AGENTS.md](../../AGENTS.md) and `research/00_README.md` first.

## Workflow

1. Small change, with a test that fails before it.
2. `npm run build && npm test`; for lifecycle, delegate or git changes also `npm run test:e2e`.
3. Update the matching pages in `docs/user/` and `docs/dev/` (English only).
4. Add a line to `CHANGELOG.md` under "Unreleased".
5. Commit locally on `main` with a message that says what changed and why.

## Conventions

- TypeScript strict, ESM, Node 22+. Imports at the top of the module; no dynamic imports.
- `switch` over unions ends with a `never` check.
- No runtime dependencies; dev dependencies only for building and testing.
- Each module belongs to one component of `research/01_architecture.md` §4.
- Hand-written validators; JSON Schemas in `schemas/` are documentation kept in sync by tests.
- CLI JSON is an interface: add fields, never rename them without a protocol bump.
- Never edit `vendor/sev3-toolkit/`; never change SEV3.
- git through `src/git/git.ts` only; never push, reset, rebase or stash.
