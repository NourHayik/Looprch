# Changelog

All notable changes to Looprch are documented here. The project follows semantic versioning.

## 0.6.3 - 2026-10-08

### Fixed

- The test-repair budget (`limits.repair_rounds`) was phase-wide. In CoreBit P-001, five test
  repairs were spent before the first review. After the review repair, which ran as 11 Planner
  repair packages executed by DeepSeek, the first test failure blocked at once. Each review that
  requests changes now starts a new cycle with a fresh test-repair budget (`test_repairs` and
  the extra rounds granted by `resume` reset).

## 0.6.2 - 2026-10-08

### Fixed

- In CoreBit P-001, the Planner's test-repeat design worked: DeepSeek executed the repair
  package, the Tester passed and every gate was green. The phase still stopped at
  `repair_limit`, because one unbacked Tester claim needed a Tester-only evidence round, and that
  round shared the budget the Implementer's test repairs had used up. The two loops measure
  different things. Tester evidence rounds now have their own budget (`limits.repair_rounds`,
  reset before each review; `status --json` shows `current.evidence_rounds`) and no longer count
  as test repairs.

## 0.6.1 - 2026-10-08

The first CoreBit P-001 run on 0.6.0 (Implementer DeepSeek, Tester Grok 4.7) showed the new
flow working. DeepSeek executed all 10 work packages, and the Tester caught defects before any
review: 8, then 2, then 1, then 1. But the last failure kept coming back. The validator still
accepted executable strings inside nested objects without a schema, while the Implementer patched
sibling fields three times; the phase stopped at `repair_limit`. Failures caught by tests and
gates went straight back to the cheap Implementer, without the Planner's design.

### Changed

- When a test or gate failure comes back after the Implementer's own repair (the same failure
  id or gate), the Planner first writes repair packages for that round, as for review findings
  (`[REPAIR DESIGN]`, reason `test_repeat`).
- `looprch resume` after `repair_limit` in a test repair opens a Planner repair design for the
  open failures. A resume note goes to that Planner run.

## 0.6.0 - 2026-10-07

Looprch's goal is that an expensive model (the Planner, Plan Debater and Reviewer) makes every
design decision and judges the result, while a cheaper model executes the plan literally. On
0.5.x, the fresh CoreBit P-001 run did the opposite.

The plan was an architect's brief: 48 lines of prose and 30 obligations whose `enforcement`
averaged 9 words ("one complete module-graph and source-ownership validator driven by the module
registry"). It named no classes, signatures, schemas or algorithms. One Implementer run then
designed and wrote 382 files in 47 minutes, and round 1 found 27 of 43 contract items unmet.
One repair run then received 25 serious findings with about 90 acceptance checks; 3 were fixed.

Protocol 3: a phase in progress pauses until `looprch resume`.

### Added

- **Work packages.** The contract carries `work_packages`: ordered packages with `depends_on`,
  the obligations they build, every file with what it contains afterwards (classes, signatures,
  schemas, keys), concrete steps, and `done_when` checks the Implementer runs itself. Looprch
  checks that:
  - every obligation is built by a package;
  - ids are unique and the order is acyclic;
  - no package exceeds 25 steps or 25 files.

  The Planner writes for a literal executor: two cheap models following a package should write
  the same code. The Plan Debater has a new executability check.
- **One package per Implementer run.** The Implementer gets one package per run, in order, and
  names it in `work_package`. Each package ends with a checkpoint commit ("implementation WP-n")
  and the progress line `[PACKAGE DONE]`.
- **Repair packages for every review round.** Before the Implementer repairs, the Planner turns
  the findings into `repair_packages`: at most 5 findings each, with exact files, steps and
  checks. The Implementer executes one package per run and resolves only that package's
  findings. A contract amendment is still required for design causes, repeated findings and
  `needs_design`. The Plan Debater challenges a design only when it amends the contract for a
  high or critical finding, or replaces a design that did not hold.
- `status --json` shows `current.work`.
- Gate provenance in `gates.json`. CoreBit's spec needs, for each gate, the runner and its
  version, start and finish time, source commit and output hashes; Looprch did not record all of
  them (CoreBit finding R-19). Each gate run now adds `finished_at`, `runner` (`looprch` and its
  version), `head_commit`, `stdout_sha256` and `stderr_sha256`.

### Fixed

- A `needs_design` resolution could not open a design for a finding that already had the
  round's design; it now gets one design per round.

## 0.5.3 - 2026-10-07

### Fixed

- CoreBit P-001 blocked at `repair_limit` with all gates green. The Implementer had honestly
  reported a finding `not_fixed` after its repair design, because the design needs a CI trust
  anchor outside the repository. The Tester failed that finding, and Looprch sent it back to the
  Implementer as a test repair three times. Each time the Implementer answered `not_fixed`
  without a change; the test-repair loop has no escalation. Now, when the gates pass and the
  Tester's only failures are ids the Implementer's latest resolutions report as `not_fixed`, the
  phase goes to the review instead (`[WARNING]` names them). The re-review then judges them and
  the review ladder applies: a redesign with a Plan Debater challenge, and the user's
  final-review decision.

## 0.5.2 - 2026-10-07

### Fixed

- A Tester result that verified a review finding without naming a testcase for every acceptance
  check was rejected as invalid; after the one re-ask it blocked the phase (`result_invalid`).
  That is what happened in CoreBit P-001 after the round 1 repair. A missing check proof is a
  gap in the evidence, not a malformed result. It now goes the same way as an unbacked
  testcase: after the gates, a round goes to the Tester alone (counted as a test repair), and
  its delta names each unproven check.

## 0.5.1 - 2026-10-07

The first CoreBit P-001 validation on 0.5.0 was stopped after review round 2. The contract and
debate worked: the plan deferred authentication and tenant routing with fail-closed interims, and
round 1 found 28 findings tied to contract obligations. But the old symptom came back. The
Implementer reported all 25 of its findings `fixed`, the Tester verified all 28, and round 2
found 23 of them `unfixed`. The Reviewer judged the frozen Fix conditions, so the rules did not
move; the repairs were incomplete. Two holes let the Tester's claims through:

- Several verifications cited testcases that had already passed on the tree where the Reviewer
  found the defect. Such a test cannot prove a repair.
- New tests covered only the Reviewer's example. The Fix for R-24 named invalid dates and
  oversized fractions; the tests rejected those, while 15 integer digits were still accepted.

### Changed

- High and critical review findings list `checks`: the acceptance checks of the repair, one
  testable condition each, covering the example and the rule's variants. The checks are frozen
  with the Fix, shown to the Implementer, Tester and Reviewer as `Check n` lines, and judged per
  check in re-reviews (`prior[].failed_checks`).
- A verified finding with checks names the testcases for every check (`verifications[].checks`).
- Gate evidence: for each open review finding and each check, at least one cited testcase must
  not have passed on the reviewed tree (Looprch keeps the passing testcases of each gate batch).
  Without named testcases, a cited test file must have changed since that tree. A stale proof
  sends the round to the Tester alone; that round's delta keeps the Fix and the checks.

## 0.5.0 - 2026-10-07

The CoreBit P-001 runs on 0.4.x kept ending the same way. The Implementer reported a finding
`fixed`, the Tester reported it `Verified`, and the next review found it `unfixed`. That
happened in five review rounds (22, 15, 7, 7 and 5 findings). The causes were structural, not
only model quality:

- The plan never defined the trust source for authentication. It never decided how write
  ownership is enforced, and never said what "every database target" means. The Implementer
  invented these designs, and the Debater did not catch them.
- Each round, the Reviewer kept the finding id but rewrote its Fix. The Implementer patched the
  new example and the Tester confirmed that same example. Nothing tied a `fixed` or a `Verified`
  to the diff or to a test that ran.
- A design defect could only come back to the Implementer as another patch.

The approved plan is now a machine-checked contract shared by every role, and completion claims
are checked against evidence. Protocol 2: a phase in progress pauses until `looprch resume`.

### Added

- **Phase contract.** `plan_ready` and `plan_final` return a `contract` with obligations and
  deferrals:
  - An obligation states a rule or behavior, the single place that enforces it, what the Tester
    must prove, and which gates prove it.
  - A deferral states what a later phase delivers, which phase, and the fail-closed behavior until
    then.

  Looprch writes `.looprch/phases/P-NNN/contract.json` and checks that:
  - every requirement id mapped to the phase is covered;
  - requirement and gate ids exist;
  - deferrals target a later phase;
  - deferrals from closed phases (`incoming-deferrals.json`) are covered.

  The Implementer, Tester, Reviewer and the handover all get the contract. `handover.md` lists
  the contract status and the deferrals to later phases.
- **Debate dispositions.** The Debater challenges the plan and the contract with a fixed list:
  - requirements
  - trust sources
  - architecture
  - enforcement that only recognizes known bad cases
  - testability
  - failure behavior
  - cross-phase dependencies
  - places where the Implementer would have to invent a design

  The synthesis must accept or reject every debate finding. An accepted finding names the
  obligations that carry it.
- **Finding `cause`.** Each review finding names its cause (`implementation`, `plan`,
  `requirement`, `cross_phase` or `test`) and the `obligations` it concerns. Round 1 reports
  `contract_review` (met or not_met) for every obligation and deferral; every `not_met` needs a
  finding. A report without `## Coverage` is re-asked.
- **Finding lineages.** A finding's Fix does not change between rounds. A re-review says `fixed`
  or `unfixed` for every earlier finding (`prior`). It may reuse an id only as `unfixed`. A new
  way to break the same rule is a new finding with `related`. `status --json` shows the lineages
  in `current.finding_ledger`.
- **Repair designs as contract amendments.** These findings go to a Planner repair design before
  the Implementer runs:
  - findings with a plan, requirement or cross-phase cause (already in round 1);
  - findings a re-review reports as `unfixed`;
  - `related` findings;
  - the Implementer's `needs_design` resolutions.

  The design is a `contract_amendment` that lists the findings it answers in `resolves`. When the
  design covers a high or critical finding, or replaces a design that did not hold, the Plan
  Debater challenges it once (`design_review`) and the Planner revises it. New progress lines:
  `[CONTRACT]`, `[CONTRACT AMENDED]`, `[REPAIR DESIGN]` and `[DESIGN DEBATE COMPLETE]`.
- **Tester verifications backed by gate evidence.** The Tester returns `verifications`:
  - on its first run, one per obligation and deferral;
  - after a review repair, one per finding.

  Each verification names the testcases that prove it and the variants tried. After the gates,
  Looprch matches every claimed testcase against the passing testcases of its own gate run
  (JUnit, or verbose unittest output). Without named testcases, the claim must name an existing
  test file and a name in it. Unbacked claims send a round to the Tester alone
  (`[EVIDENCE MISMATCH]`, counted as a test repair).
- **Implementer `fixed` checked against the diff.** A `fixed` resolution lists its `files`, and
  Looprch rejects it when none of them changed since the reviewed tree.

### Changed

- Role prompts:
  - The Planner writes an implementation-ready plan with explicit trust boundaries, deferrals and
    an enforceability rule: one point whose completeness can be checked, never a list of bad
    forms.
  - The Implementer asks for a design (`needs_context`, `needs_design`) instead of inventing one.
  - The Tester derives its obligations from the contract and tries to falsify every repair.
  - The Reviewer reviews against the contract and beyond it.
- New journal events: `contract.accepted`, `contract.amended`, `design.escalated`,
  `evidence.checked` and `evidence.unbacked`. `result.accepted` adds `cause`, `related`,
  `obligations`, `verifications`, `prior`, `contract_unmet` and `dispositions`.
- `PROTOCOL` is 2.

## 0.4.2 - 2026-10-06

With 0.4.1 the CoreBit run went into a fourth review (allowed by the user). The same four
findings came back `unfixed` again, each reported `fixed` by the Implementer and verified by
the Tester. They need a design decision, not another patch. For example, P-001 has no trusted
authentication source, so the rule can only be enforced by failing closed until a later phase
adds one.

### Changed

- Implementer findings that a re-review reports as `unfixed` now go to the Planner first. In the
  same session, the Planner writes a repair design addendum (`plan-addendum-N.md`) through the
  existing `context_answer` path. For each finding it gives the rule, the requirement, the single
  code path that enforces it, and what fails closed in this phase. The Implementer, Tester and
  Reviewer get the addendum as a binding input.
- The Implementer's "still open" list names only its own findings, not Tester-owned ones.
- `[CONTEXT ANSWERED]` says whether the addendum is a context answer or a repair design.

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
