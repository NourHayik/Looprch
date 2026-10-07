# Schemas

JSON Schemas in `schemas/` document the files; the CLI validates with hand-written validators
(no zod/ajv) and unit tests keep both in sync.

| File | Schema | Validator |
|---|---|---|
| `.looprch/config.json` | `schemas/config.schema.json` | `validateConfig` in `src/core/config.ts` |
| `.looprch/state.json` | `schemas/state.schema.json` | typed by `State` in `src/core/state.ts` |
| `.looprch/events.jsonl` (one line) | `schemas/events.schema.json` | `appendEvent` / `EVENT_TYPES` |
| `.looprch/phases/P-NNN/gates.json` | `schemas/gates.schema.json` | written by `src/gates/runner.ts` |
| `looprch-result` block | `schemas/role-results.schema.json` | `validateResult` in `src/core/results.ts` |

## config.json (schema_version 1)

`project.id`, `lead_host`, `agents[]`, `roles.<role>` (`mode`, `agent`, `model`, `effort`,
`timeout`, `context_kb`, `fallbacks[]`, `max_parallel` for worker), `context_kb.<agent>`,
`limits` (`repair_rounds` 3, `quota_wait_minutes` 60, `run_attempts` 2, `dispatch_max_wait`
"10m", `expansion_rounds` 2, `review_rounds` 3, optional so older configs stay valid), `approvals` (`plan`, `merge`: never | high-risk | always),
`git.phase_branches`, `gates.env`, `integrations.commit_generated`, `spec.gates_ack`
(`manifest_sha256`, `acknowledged_at`, `commands[]`).

## state.json (schema_version 1)

`protocol`, `core_version_at_phase_start`, `scope`, `spec` (package and source fingerprints,
manifest hash, phases_total), `git` (`base_branch`, `baseline_commit`), `current` (phase, stage,
round, close_step, phase_base, branch, last_commit, active_run, tester verdict and failures,
review findings, `review_changes` (reviews that requested changes; absent in older files), `test_repairs`,
`extra_reviews`, `final_review_pending`, `reviewed_tree`, `repair_reports`, `review_notes`, `debate_findings`, `finding_ledger` (per finding id: lineage, severity, cause, owner, first Fix, rounds, reports, repair designs, open or fixed), `design` (a Planner repair design in progress: findings, step `design`/`debate`/`revise`, whether the Debater challenges it, reason), `designed_this_round`, `tester_verifications`, `contract_review` (all optional), deltas per role, assignment index per role, sessions-related counters,
snapshots), `flags` (`pause_requested`, `paused`, `waiting`, `blocked`), `pending_question`,
`answers`, `pending_checkpoint`, `runs_index`, `sessions` (key `P-NNN/<role>/<agent>`),
`assignments_history`, `quota.exhausted` (rate-limit marks), `phases.<id>` (status, tag,
merge commit, rounds, implementers), `project`.

## Role results

The last fenced block with info string `looprch-result` in a role's final message. Common
fields: `role`, `decision`, optional `run_id`. Decisions per role:

| Role | Decisions | Extra fields |
|---|---|---|
| planner | `plan_ready`, `plan_final`, `needs_expansion`, `context_answer` | `contract{obligations[], deferrals[]}` (required with `plan_ready`/`plan_final`); synthesis: `debate_dispositions[{id, decision: accept or reject, reason, refs[]}]`; context answer: `contract_amendment{obligations[], deferrals[], retire[]}` (required for a repair design); `expansion_requests[]` |
| plan_debater | `findings`, `no_findings`, `needs_expansion` | `findings[{id, severity, summary, section, refs[]}]` (also for the `design_review` task) |
| implementer | `implemented`, `needs_context`, `handover_ready` | `files_changed[]`; after a review: `resolutions[{id, status: fixed, not_fixed or needs_design, note, files[]}]`, one per finding in the delta; `context_request{question, reason}`; handover: `modified_files`, `new_files`, `deleted_files`, `renamed[{from,to}]`, `verification_ids`, `limitations` |
| tester | `pass`, `fail` | `tests_written[]`, `verifications[{id, status: verified, failed or inspected, tests[], checks[{n, tests[]}], variants[], note}]`, `failures[{id, gate_id, summary}]`, `manual_gate_reports[{gate_id, path}]` |
| reviewer | `approve`, `changes_requested` | `findings[{id, severity, summary, files[], fix, checks[] (required for high and critical), owner: implementer or tester, cause: implementation, plan, requirement, cross_phase or test, obligations[], related, origin: unfixed, regression or missed (re-reviews)}]`, `contract_review[{id, status: met or not_met}]` (first review), `prior[{id, status: fixed or unfixed}]` (re-reviews), `manual_gate_reports[{gate_id, path}]` |
| worker | `answered` | `evidence[{path, lines, note}]` |

Expansion request: `{kind: "document"|"phase", id, question, reason}`.

Phase rules checked against the state (`phaseRuleViolation`; one re-ask, then `result_invalid`):

| Result | Rule |
|---|---|
| plan (planning, synthesis, revise) | every `requirements` id of the phase is covered by an obligation or deferral; requirement ids exist in the manifest; gate ids are the phase's; `to_phase` is a later phase; ids are unique; every incoming deferral is listed in `covers` |
| synthesis | every Plan Debater finding has a disposition; an accepted one names contract ids in `refs` |
| repair design (context answer) | `contract_amendment` is present and lists every design finding in `resolves`; the amended contract still passes the plan rules |
| repair after a review | a resolution for every assigned finding; a `fixed` resolution names files that changed since the reviewed tree |
| testing | the first run verifies every obligation and deferral; after a review repair, every finding in the delta; `pass` has no `failed` verification; high and critical findings are `verified` with `variants`; `inspected` only for procedural obligations or obligations without a test gate |
| gates (evidence) | every claimed testcase passed in this gate batch (or, without named testcases, names an existing test file and name); a verified open review finding names testcases for every acceptance check, and per check at least one cited testcase did not pass on the reviewed tree (without named testcases: its file changed since that tree) |
| review | high and critical findings list `checks`; the report has a `## Coverage` section; round 1 covers every contract id in `contract_review`, and each `not_met` is cited by a finding; finding `obligations` exist; a re-review gives `prior` for every earlier finding, reuses an earlier id only as `origin: unfixed`, gives new findings new ids with `regression` or `missed`, and `related` names an earlier finding; the final review blocks only on high or critical |

## contract.json (schema_version 1)

`.looprch/phases/P-NNN/contract.json`, written by Looprch from the Planner's result (earlier
versions kept as `contract.rN.json`): `phase`, `revision`, `obligations[{id, requirements[],
kind: behavior, invariant, boundary, interface, data, failure, production or procedure,
statement, enforcement, verify, gates[], covers[], resolves[]}]`, `deferrals[{id,
requirements[], what, to_phase, interim, covers[], resolves[]}]`. `incoming-deferrals.json` in a
later phase lists the deferrals closed phases made to it, each with `from_phase` and `ref`
(`P-NNN/X-n`).
