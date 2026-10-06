# Changelog

All notable changes to Looprch are documented here. The project follows semantic versioning.

## 0.4.1 - 2026-10-06

The 0.4.0 validation run on CoreBit P-001 worked as intended in round 1: 22 findings, and
round 2 found only 2 `missed`. But 12 of the 19 findings the Implementer reported as fixed came
back `unfixed`, and 6 were still open in round 3. Each round the Reviewer probed a new variant
of the same defect (for example another way to reach a production database). The Implementer
patched that one example, and the Tester re-ran only that example.

### Changed

- Reviewer findings describe the broken rule, not only the example that exposed it. The `fix`
  states the rule for all inputs and the variants the Reviewer knows of.
- The Implementer fixes the rule (preferring one fail-closed path over patching cases), tries
  variants of the Reviewer's probe, and reports `fixed` only when the whole rule holds,
  otherwise `not_fixed` with what remains.
- The Tester verifies each finding with at least one variant the Reviewer's example did not
  cover, and lists the variants it tried.
- Findings a re-review reports as `unfixed` are named in the next repair and Tester briefs as
  having come back after an earlier repair. The `final_review` question shows the origin counts.

## 0.4.0 - 2026-10-06

Driven by the CoreBit P-001 test run on 0.3.0. It used three review rounds and still ended
blocked with a high finding open. Round 1 missed four defects that existed at the
implementation commit. Rounds 2 and 3 mostly found incomplete fixes and a regression from an
over-fix. A test-owned finding went to the Implementer, who may not edit tests.

### Changed

- The first review is a structured, comprehensive pass. The Reviewer reads every changed file,
  walks every plan step and requirement id, and checks a fixed list: requirements, plan
  compliance, completeness, correctness, integration, regressions, edge cases and error
  handling, security, performance, maintainability, tests, build and runtime, and production
  readiness. The report starts with a `## Coverage` section. The brief gives the exact diff
  command against the tree the gates ran on, which includes the Tester's new files.
- Re-reviews are a safety net, not a narrow check. They get the repair diff (from the last
  reviewed tree), the open findings and the Implementer's repair reports. They report unfixed
  findings, regressions and anything round 1 missed, and tag each with
  `origin: unfixed | regression | missed`. The rules "no new findings on unchanged code unless
  high or critical" and "do not reopen settled code" are gone.
- Review findings carry `fix` (the condition the repair must meet) and `owner` (`implementer` or
  `tester`). The Implementer gets only its own findings. Findings owned by the Tester go to the
  Tester, and when every finding is test-owned the Implementer run is skipped.
- A repair after a review must return `resolutions` (`fixed` or `not_fixed`) for every finding
  assigned to it; a missing one is re-asked. The Tester verifies every finding with a test or a
  command against the evidence the gates produce, and returns `fail` with the finding id when
  one is not fixed. The Tester and the next Reviewer get the repair reports.
- `limits.repair_rounds` now counts only repairs after failing tests or gates. Review repairs are
  bounded by `limits.review_rounds`, so a test failure can no longer use up the repair that
  follows a review.
- When the final allowed review still requests changes, Looprch asks you (`final_review`):
  `repair_and_review` (one more review), `repair_and_handover` (the 0.3.0 path: a final
  repair, then handover without review, with the open findings listed), or `pause`. Before,
  the unreviewed handover happened automatically.
- The final review lists every remaining issue in `findings`. Its `changes_requested` needs a
  high or critical finding (else the re-ask). An approval's findings are listed in
  `handover.md` as "Open review notes (approved, not repaired)".
- Review rounds get more time each round: round n runs with the Reviewer timeout × (1 + 0.5 ×
  (n − 1)), 60m, 90m and 2h by default, passed as the relay `--timeout`. The brief states the
  time budget.

### Fixed

- The reviewer output contract showed `"manual_gate_reports": []` without the
  `{gate_id, path}` shape. Reviews that listed plain paths were rejected; in CoreBit that cost a
  10-minute first review and discarded an 11-finding ad hoc review.
- `result.accepted` kept only the first five findings; it now keeps all of them, with `owner`
  and `origin`, plus `review_round`, `review_cap` and `resolutions`. `run.issued` gains
  `timeout`, `review_round` and `review_cap`. `[REVIEW COMPLETE]` shows the round and the origin
  counts, and `[REPAIR COMPLETE]` shows the resolutions.
- A Planner context answer during a repair no longer drops the repair's findings from the
  Implementer's delta.
- Resumed Reviewer and Tester sessions are told to inspect the current code, not to re-read
  only what the delta names.
- `looprch status --json` adds `current.test_repairs` and `current.final_review_pending`;
  `review_cap` includes the extra reviews you allowed.

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
