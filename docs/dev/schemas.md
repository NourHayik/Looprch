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
`extra_reviews`, `final_review_pending`, `reviewed_tree`, `repair_reports`, `review_notes` (all optional), deltas per role, assignment index per role, sessions-related counters,
snapshots), `flags` (`pause_requested`, `paused`, `waiting`, `blocked`), `pending_question`,
`answers`, `pending_checkpoint`, `runs_index`, `sessions` (key `P-NNN/<role>/<agent>`),
`assignments_history`, `quota.exhausted` (rate-limit marks), `phases.<id>` (status, tag,
merge commit, rounds, implementers), `project`.

## Role results

The last fenced block with info string `looprch-result` in a role's final message. Common
fields: `role`, `decision`, optional `run_id`. Decisions per role:

| Role | Decisions | Extra fields |
|---|---|---|
| planner | `plan_ready`, `plan_final`, `needs_expansion`, `context_answer` | `expansion_requests[]` |
| plan_debater | `findings`, `no_findings`, `needs_expansion` | `findings[{id, severity, summary, section}]` |
| implementer | `implemented`, `needs_context`, `handover_ready` | `files_changed[]`; after a review: `resolutions[{id, status: fixed or not_fixed, note}]`, one per finding in the delta; `context_request{question, reason}`; handover: `modified_files`, `new_files`, `deleted_files`, `renamed[{from,to}]`, `verification_ids`, `limitations` |
| tester | `pass`, `fail` | `tests_written[]`, `failures[{id, gate_id, summary}]`, `manual_gate_reports[{gate_id, path}]` |
| reviewer | `approve`, `changes_requested` | `findings[{id, severity, summary, files[], fix, owner: implementer or tester, origin: unfixed, regression or missed (re-reviews)}]`, `manual_gate_reports[{gate_id, path}]` |
| worker | `answered` | `evidence[{path, lines, note}]` |

Expansion request: `{kind: "document"|"phase", id, question, reason}`.
