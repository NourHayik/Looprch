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
"10m", `expansion_rounds` 2, `review_rounds` 3, `debate_rounds` 3, `readback_rounds` 2, `lineage_attempts` 2, the last four optional so older configs stay valid), `approvals` (`plan`, `merge`: never | high-risk | always),
`git.phase_branches`, `gates.env`, `integrations.commit_generated`, optional `integrations.e2e`
(`enabled`, `configured_at`, `config`, `bin`, `args[]`, `timeout`, `env`, `required_env[]`,
`phases`: "all" or ids; `enabled` true needs `configured_at`), `spec.gates_ack`
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
| planner | `plan_ready`, `plan_final`, `needs_expansion`, `context_answer` | `contract{obligations[], deferrals[], decisions[], interfaces[], work_packages[]}` (required with `plan_ready`/`plan_final`); synthesis and revise: `debate_dispositions[{id, decision: accept, partial or reject, reason, refs[], evidence}]` for every open ledger item; context answer: `repair_packages[]` (required for a repair design), `contract_amendment{obligations[], deferrals[], decisions[], interfaces[], work_packages[], retire[]}` (required for the design's `amend` findings); `expansion_requests[]` |
| plan_debater | `findings`, `no_findings`, `agree`, `needs_expansion` | `findings[{id, severity, summary, section, refs[], evidence, failure_scenario, proposed_resolution}]` (the last three required); debate: `independent_risks[{risk, covered_by[]}]` (required); rebuttal: `verdicts[{id, verdict: resolved, conceded or upheld, note}]` for every open item, `agree` only without upheld or new items above low |
| implementer | `implemented`, `needs_context`, `handover_ready`, `ready`, `questions` | readback (`ready`/`questions`): `packages[{id, questions[], decisions_needed[], would_create[{path, symbols[]}]}]`, one per work package; `files_changed[]`; `work_package` (or `work_packages[]` for a chain); `deviations[{file, what, why}]` for every changed file the package does not list; after a review: `resolutions[{id, status: fixed, not_fixed or needs_design, note, files[]}]`, one per finding in the delta; `context_request{question, reason}`; handover: `modified_files`, `new_files`, `deleted_files`, `renamed[{from,to}]`, `verification_ids`, `limitations` |
| tester | `pass`, `fail` | `tests_written[]`, `verifications[{id, status: verified, failed or inspected, tests[], checks[{n, tests[]}], variants[], note}]`, `failures[{id, gate_id, summary}]`, `manual_gate_reports[{gate_id, path}]` |
| reviewer | `approve`, `changes_requested` | `findings[{id, severity, summary, files[], fix, checks[] (required for high and critical), owner: implementer or tester, cause: implementation, plan, requirement, cross_phase or test, obligations[], related, origin: unfixed, regression or missed (re-reviews), repair{files[], steps[], done_when[], tests[]} (cause implementation, not low, not unfixed or related)}]`, `contract_review[{id, status: met or not_met}]` (first review: obligations, deferrals, decisions, contested debate items, deviations), `files_reviewed[]`, `prior[{id, status: fixed or unfixed}]` (re-reviews), `manual_gate_reports[{gate_id, path}]` |
| worker | `answered` | `evidence[{path, lines, note}]` |

Expansion request: `{kind: "document"|"phase", id, question, reason}`.

Phase rules checked against the state (`phaseRuleViolation`; one re-ask, then `result_invalid`):

| Result | Rule |
|---|---|
| plan (planning, synthesis, revise) | every `requirements` id of the phase is covered by an obligation or deferral; requirement ids exist in the manifest; gate ids are the phase's; `to_phase` is a later phase; ids are unique; every incoming deferral is listed in `covers`; every obligation is implemented by a work package; work packages have unique ids, known obligations and an acyclic `depends_on`; each has files (with `content`), steps and `done_when`, at most 25 steps and 25 files |
| plan (protocol 4) | `decisions[]` and `interfaces[]` are present and referenced consistently; boundary, invariant and failure obligations have a `rule`; every obligation except procedure has a planned test, closed rules a non-positive one; a package that builds a boundary or invariant is `full_content` with blueprint files; the plan lint: `modify`/`delete` paths exist (or an earlier package creates them), `create` paths do not, no TBD/TODO/FIXME, the report (the markdown that becomes plan.md) has the required sections, every blueprint file has its block |
| synthesis and revise | every open debate item has a disposition; accept and partial name refs of which at least one changed against the previous contract; reject has evidence; items the user decided for the Debater are accepted |
| debate | `independent_risks` is not empty |
| rebuttal | a verdict for every open item and only for open items; `agree` only without upheld verdicts or new findings above low; new findings have new ids |
| readback | `packages` covers every work package |
| repair design (context answer) | `repair_packages` list every design finding in `findings` (at most 5 findings, 25 steps and 25 files per package, acyclic `depends_on`); `contract_amendment` lists every `amend` finding in `resolves`; the amended contract still passes the plan rules (except that new obligations are built by repair packages) |
| implementation or repair with a package | the result names the package in `work_package` (a chain in `work_packages`); files changed since the package started that it does not list are reported in `deviations` |
| repair after a review | a resolution for every finding of the package (or, without packages, of the delta); a `fixed` resolution names files that changed since the reviewed tree |
| testing | the first run verifies every obligation, deferral and planned test (a planned test is never `inspected`); after a review repair, every finding in the delta; `pass` has no `failed` verification; high and critical findings are `verified` with `variants`; `inspected` only for procedural obligations or obligations without a test gate |
| gates (evidence) | every claimed testcase passed in this gate batch (or, without named testcases, names an existing test file and name); a verified open review finding names testcases for every acceptance check, and per check at least one cited testcase did not pass on the reviewed tree (without named testcases: its file changed since that tree) |
| review | high and critical findings list `checks`; implementation findings carry `repair`; the report has a `## Coverage` section; `files_reviewed` covers every file the phase (round 1) or the repair (re-review) changed; round 1 covers every obligation, deferral, decision, contested debate item and deviation in `contract_review`, and each `not_met` is cited by a finding; finding `obligations` exist; a re-review gives `prior` for every earlier finding, reuses an earlier id only as `origin: unfixed`, gives new findings new ids with `regression` or `missed`, and `related` names an earlier finding; the final review blocks only on high or critical |

## contract.json (schema_version 1)

`.looprch/phases/P-NNN/contract.json`, written by Looprch from the Planner's result (earlier
versions kept as `contract.rN.json`): `phase`, `revision`, `obligations[{id, requirements[],
kind: behavior, invariant, boundary, interface, data, failure, production or procedure,
statement, rule, enforcement, verify, gates[], covers[], resolves[]}]`, `deferrals[{id,
requirements[], what, to_phase, interim, covers[], resolves[]}]`, `decisions[{id, decision,
rationale, rejected_alternatives[], requirements[], obligations[]}]`, `interfaces[{id, file,
symbol, signature, errors[], invariants[]}]`, `work_packages[{id, title, depends_on[],
obligations[], decisions[], interfaces[], sources[], precision: spec or full_content,
files[{path, action: create, modify or delete, content, blueprint}], steps[], done_when[],
tests[{id, obligation, kind: positive, negative, boundary or adversarial, given, when, then,
file}]}]`. Contracts from protocol 3 lack the protocol 4 fields and stay valid. Blueprints are
written to `blueprints/<path>` beside the contract. `debate.json` is the debate ledger
(`src/core/debate.ts`), `traceability.md` the generated matrix, `changed-files.txt` the review
input. Repair packages have the same shape with `findings[]` instead of `obligations[]`. `incoming-deferrals.json` in a
later phase lists the deferrals closed phases made to it, each with `from_phase` and `ref`
(`P-NNN/X-n`).
