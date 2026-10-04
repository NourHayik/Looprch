# Changelog

All notable changes to Looprch are documented here. The project follows semantic versioning.

## 0.1.1 - 2026-10-04

### Changed

- Hermes docs explain why the `/lr-*` commands can be missing: Hermes loads project skills only
  in a git repository trusted with `hermes skills trust`, and only in sessions started after it.
  The Hermes install note says the same.
- The README, install and quickstart docs install from npm (`npx looprch@latest install`);
  GitHub stays as the alternative.

## 0.1.0 - 2026-10-03

First version of the rewrite, published on npm.

### Added

- `looprch` CLI bundled into one ESM file (Node 22+, no runtime dependencies) with a
  deterministic phase state machine: `next`, `record`, `dispatch`, `gates run`, `checkpoint`,
  `answer`, `wait`, `pause`, `resume`.
- Ten agent skills: `/lr-init`, `/lr-doctor`, `/lr-status`, `/lr-phase`, `/lr-auto`, `/lr-pause`,
  `/lr-resume`, `/lr-review`, `/lr-finish`, `/lr-worker`.
- Central install under `~/.looprch` with `install`, `update`, `rollback`, `uninstall`,
  `self-test`, a shim in `~/.local/bin`, and `install.sh` for `curl | sh`.
- Project attachment (`add`, `remove`, `list`) for Codex, Cursor, Antigravity, Kimi Code, Hermes,
  OpenCode and Grok Build (experimental), with symlink or copy mode and an `AGENTS.md` block.
- SEV3 integration with the vendored toolkit 1.2.0: discovery, toolkit trust, verification,
  package and source fingerprints, exact-source packets with expansion requests, `todo.md` ticks.
- Gate runner with unittest and JUnit evidence parsing bound to working-tree hashes.
- Direct and Delegate modes with automatic Direct→Delegate when the Lead runs elsewhere,
  detached delegate-skills dispatch with `await_run`, per-phase sessions, retries and fallbacks.
- QuotaLens wait/fallback policy for every role, rate-limit detection, context-size guard.
- Git integration: baseline commit, `looprch/P-NNN` branches, stage checkpoints, `--no-ff`
  merges and `looprch/P-NNN` tags; never push, reset, rebase or stash.
- `doctor`, `status`, `log`, `config`, `models`, `install-relay`, `init`, `worker`, `review`.
- User and developer documentation, verification spike results, unit/integration/e2e tests on
  the SEV3 notes-spec example with fake relays.

### Fixed

- Installation works without the npm registry: `npx github:NourHayik/Looprch install` builds the
  package through a new `prepare` script. `install.sh` and `looprch update` use the npm registry
  when `looprch` is published there and the GitHub repository otherwise; doctor and error hints
  point at the GitHub command.
