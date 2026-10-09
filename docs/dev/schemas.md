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
"10m", `expansion_rounds` 2, `review_rounds` 3, `debate_rounds` 2; the last two optional so older
configs stay valid), `approvals` (`plan`, `merge`: never | high-risk | always),
`git.phase_branches`, `gates.env`, `integrations.commit_generated`, optional `integrations.e2e`
(`enabled`, `configured_at`, `config`, `bin`, `args[]`, `timeout`, `env`, `required_env[]`,
`phases`: "all" or ids; `enabled` true needs `configured_at`), `spec.gates_ack`
(`manifest_sha256`, `acknowledged_at`, `commands[]`).

`loadConfig` drops the 0.7 limits `readback_rounds` and `lineage_attempts` and turns their
config's old default `debate_rounds: 3` into 2, then saves the file once.

The Implementer's `context_kb` (role, else agent) is passed to the Planner, which sizes the
Implementer sessions with it.

## state.json (schema_version 1)

`protocol` (5), `core_version_at_phase_start`, `scope`, `spec` (package and source fingerprints,
manifest hash, phases_total), `git` (`base_branch`, `baseline_commit`), `current` (phase, stage,
round, close_step, phase_base, branch, last_commit, active_run, tester verdict and failures,
review findings, `review_changes`, `test_repairs`, `extra_reviews`, `final_review_pending`,
`reviewed_tree`, `repair_reports`, `review_notes`, `sessions` (the plan's Implementer sessions),
`session_index`, `todos_done`, `followup_sessions`, `debate_final`, `context_request`, deltas per
role, assignment index per role, run counters, snapshots), `flags` (`pause_requested`, `paused`,
`waiting`, `blocked`), `pending_question`, `answers`, `pending_checkpoint`, `runs_index`,
`sessions` (key `P-NNN/<role>/<agent>`), `assignments_history`, `quota.exhausted` (rate-limit
marks), `phases.<id>` (status, tag, merge commit, rounds, implementers), `project`.

A phase that started under protocol 4 pauses with `protocol_changed`. `looprch resume` restarts it
at `planning`: its contract, plan and debate files move to `.looprch/phases/P-NNN/v07/`; the code
on the phase branch, the gate runs and the run counters stay.

## Role results

The last fenced block with info string `looprch-result` in a role's final message. Common
fields: `role`, `decision`, optional `run_id`. Decisions per role:

| Role | Decisions | Extra fields |
|---|---|---|
| planner | `plan_ready`, `plan_final`, `needs_expansion`, `context_answer` | `plan{todos[{id, title, section}], sessions[[ids]], requirements{id: [ids]}, deferrals[{id, what, to_phase, interim, requirements[]}]}` (required with `plan_ready`/`plan_final`); synthesis and revise: `debate_dispositions[{id, decision: accept or reject, note}]`; context answer: `new_todos[]`; `expansion_requests[]` |
| plan_debater | `findings`, `no_findings`, `agree`, `needs_expansion` | `findings[{id, severity, summary, section, suggestion}]`; rebuttal: `verdicts[{id, verdict: resolved, conceded or upheld, note}]` |
| implementer | `implemented`, `needs_context`, `handover_ready` | `todos_done[]`, `files_changed[]`, `notes`; repair: optional `resolutions[{id, status: fixed or not_fixed, note}]`; `context_request{question, reason}` with `needs_context`; handover: `limitations[]` |
| tester | `pass`, `fail` | `tests_written[]`, `failures[{id, gate_id, summary, files[]}]`, `manual_gate_reports[{gate_id, path}]` |
| reviewer | `approve`, `changes_requested` | `findings[{id, severity, summary, files[], fix, owner: implementer or tester}]` (non-empty with `changes_requested`), `manual_gate_reports[{gate_id, path}]` |
| worker | `answered` | `evidence[{path, lines, note}]` |

Expansion request: `{kind: "document"|"phase", id, question, reason}`; the ids must be SEV3
document or phase ids.

These shapes are the only result checks: a block Looprch cannot read gets one re-ask, then
`result_invalid`. Everything else is judged by the gates, the Tester and the Reviewer.

## plan.json (schema_version 1)

`.looprch/phases/P-NNN/plan.json`, written by Looprch from the Planner's `plan` block (earlier
versions kept as `plan.rN.json`): `phase`, `revision`, `todos[]`, `sessions[][]`,
`requirements{}`, `deferrals[]`. `plan.md` (earlier versions `plan.rN.md`) is the guide; Planner
answers to the Implementer are appended to it as `## Addendum N`. `debate.json` is the debate
ledger (`src/core/debate.ts`), `changed-files.txt` the review input. `incoming-deferrals.json` in
a later phase lists the deferrals closed phases made to it, each with `from_phase` and `ref`
(`P-NNN/X-n`); phases closed before 0.8 are read from their `contract.json`.

Session normalization (`normalizeSessions`): unknown and repeated ids are dropped, empty sessions
removed, todos no session lists are appended to the last session; no sessions means one session
with every todo.
