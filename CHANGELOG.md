# Changelog

All notable changes to Looprch are documented here. The project follows semantic versioning.

## 0.3.0 - 2026-10-05

### Fixed

- Antigravity (agy) can run write roles in phases. Headless `agy --print` auto-denied every tool
  permission it could not prompt for, so Implementer and Tester runs failed. Write runs now get
  `--dangerously-skip-permissions` (full access, reported as a `warning` event and by
  `looprch doctor` as `agent:agy:permissions`); read-only roles keep `--read-only`.
- agy runs get the role timeout as `--print-timeout`, so agy no longer stops itself after its
  30-minute default.
- A relay's `error` field (for example the agy permission denial) is shown in the failure detail
  instead of only the stderr tail.
- `looprch doctor` reports agy as authenticated when `agy models` listed models, instead of
  "authentication unknown".
- `looprch resume` after a `repair_limit` that a review caused continues with the repair, not
  with another review.

### Added

- `limits.review_rounds` (default 3, optional in existing configs): the Reviewer may request
  changes at most that many times per phase. After the last one, the Implementer makes a final
  repair, tests and gates must pass, and the phase goes to handover without another review. A new
  journal event `review.skipped` reports `[REVIEW SKIPPED]`, and `handover.md` lists the open
  findings. `looprch status` gains `current.review_changes` and `current.review_cap`.
- First-pass quality rules. The Implementer reviews its own diff against the Reviewer's criteria,
  and repairs fix every occurrence of a defect. The first review must report every finding at
  once. Re-reviews get the earlier findings and are limited to the repair, and the final review
  may only request changes for high or critical defects. A reviewer `changes_requested` with
  only `low` findings is rejected; use `approve` with notes.

## 0.2.0 - 2026-10-04

### Added

- The Lead reports every workflow step in the chat. `looprch next`, `record` and `dispatch`
  return a new `progress` field: tagged lines such as `[PHASE START]`, `[PLANNING COMPLETE]`,
  `[DEBATE COMPLETE]` (changes recommended with count, severities and summary, or no changes),
  `[PLAN UPDATED]`, `[TASK START]`, `[RETRY]`, `[FALLBACK]`, `[ISSUE]` (reason and next action),
  `[WAITING]`, `[GATES COMPLETE]`, `[BLOCKED]` and `[PHASE COMPLETE]`, built from the journal
  events since the last report. Human output prints them first.
- The `/lr-phase`, `/lr-auto`, `/lr-resume` and `/lr-finish` loop has a Reporting section: post
  every progress line unchanged, then one `Now: … Next: …` line; never work silently.
- New journal event `assignment.changed` for every role reassignment (quota, rate-limit, failure
  or user-chosen fallback). Existing events gain fields: `stage.entered` `round`, `run.issued`
  `attempt` (side runs: `model`), `result.accepted` `task`, `findings_total`, `severities`,
  `findings`, and `blocked` `hint`.
- The progress cursor lives in `.looprch/runs/progress.json` (gitignored). Projects upgraded from
  0.1.x start reporting with the next event.

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
