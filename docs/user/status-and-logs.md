# Status and logs

## Progress in the chat

While a loop skill runs, you do not need to ask for a status: the Lead posts each workflow step
as it happens (see [running-phases.md](running-phases.md#what-the-lead-tells-you) for an
example). The lines come from Looprch, not from the Lead's memory: `looprch next`, `record` and
`dispatch` turn the journal events written since the last report into `progress` lines, and the
Lead posts them unchanged.

| Line | When |
|---|---|
| `[PHASE START]`, `[PREFLIGHT COMPLETE]`, `[PHASE COMPLETE]`, `[PROJECT COMPLETE]` | a phase starts, passes preflight, closes; the project is done |
| `[PLANNING START]` / `[PLANNING COMPLETE]` | the Planner starts / delivers the first plan |
| `[DEBATE START]` / `[DEBATE COMPLETE]` | the plan goes to the Plan Debater / its result: changes recommended (count, severities, summary) or no changes |
| `[PLAN UPDATE START]` / `[PLAN UPDATED]` | the Planner updates the plan after the debate or your revision |
| `[PLAN]` | the plan was accepted: todos, Implementer sessions, deferrals, answered debate items |
| `[SESSION DONE]` | the Implementer finished a session (k of n) and the todos it reported done; a checkpoint commit follows |
| `[QUESTION]`, `[QUESTION ANSWERED]` | the Implementer is blocked and asks the Planner; the answer is an addendum at the end of plan.md |
| `[IMPLEMENTATION …]`, `[TESTING …]`, `[GATES …]`, `[REVIEW …]`, `[REPAIR …]`, `[HANDOVER …]`, `[CLOSING START]` | each stage starts and completes, with the verdict, findings or failed gates |
| `[REVIEW COMPLETE]` | the review round (n of N), the decision, the findings by severity and, for re-reviews, how many are `unfixed`, `regression` or `missed`; an approval lists its notes |
| `[REPAIR COMPLETE]` | after a review: how many findings the Implementer reports as fixed and which are not fixed |
| `[REVIEW SKIPPED]` | you chose to hand over after the final review; the final repair goes to handover without another review |
| `[TASK START]`, `[RETRY]` | a role run starts: run id, role, task, agent/model, mode, attempt, fallback reason; reviews add the round and the time budget |
| `[ISSUE]` | a run failed, was interrupted or returned an invalid report: reason and what Looprch does next |
| `[FALLBACK]` | a role moves to its next approved agent/model |
| `[WAITING]` | a quota or rate-limit wait |
| `[DECISION NEEDED]`, `[DECISION]` | Looprch needs your answer / records it |
| `[CHECKPOINT]`, `[EXPANSION]`, `[CONTEXT NEEDED]`, `[CONTEXT ANSWERED]`, `[NOTE]`, `[WARNING]` | checkpoint commits, extra sources, cross-phase context, Direct→Delegate, warnings |
| `[PAUSED]`, `[RESUMED]`, `[BLOCKED]` | the loop pauses, resumes or stops (with the fix) |

Each event is reported once. The cursor is `.looprch/runs/progress.json` (gitignored); if it is
missing, reporting starts with the next event. The full history stays in `looprch log`.

## looprch status

```text
Looprch 0.1.0 · project corebit · spec 89 phases (fingerprint 0a13…) · 2 closed
Phase P-003 (3/89) "Tenant registry"  stage: testing  repair round 1 (test/gate repairs 0/3)  review changes 1/3
Active: tester · codex · delegate · session 019a1234 · running for 6 min
Last result: implementer implemented (opencode) · 14 files touched
Blockers: none    Next: run gates after the tester report
```

`looprch status --json` returns the same data: `version`, `project`, `spec`
(`package_fingerprint`, `phases_total`, `phases_closed`), `current` (`phase`, `title`, `index`,
`stage`, `round` (all repairs), `cap` (test/gate repair limit), `test_repairs`, `review_changes`, `review_cap`, `final_review_pending`), `active` (`run_id`, `role`, `agent`, `mode`, `effective_mode`,
`mode_reason`, `session_id`, `started_at`, `elapsed_s`), `last_result`, `flags` (`paused`,
`waiting`, `blocked`), `pending_question`, `next`.

`direct→delegate` in the Active line means a Direct role runs through its agent's relay because
the Lead is in another agent.

## looprch log

```sh
looprch log                    # last 50 events
looprch log --phase P-002 -n 20
looprch log --type gate.result --json
```

The journal `.looprch/events.jsonl` is append-only and committed with each phase. Event types
include `phase.started`, `stage.entered`, `run.issued`, `run.dispatched`, `result.accepted`,
`gate.result`, `checkpoint.committed`, `quota.fallback`, `assignment.changed`, `blocked`,
`phase.closed`.

## Run archive

Every role run keeps its brief, the relay's `result.json`, event stream, stderr and the final
message under `.looprch/runs/<run_id>/` (gitignored). See
[docs/dev/debugging.md](../dev/debugging.md).
