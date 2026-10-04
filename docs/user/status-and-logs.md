# Status and logs

## looprch status

```text
Looprch 0.1.0 · project corebit · spec 89 phases (fingerprint 0a13…) · 2 closed
Phase P-003 (3/89) "Tenant registry"  stage: testing  repair round 1/3
Active: tester · codex · delegate · session 019a1234 · running for 6 min
Last result: implementer implemented (opencode) · 14 files touched
Blockers: none    Next: run gates after the tester report
```

`looprch status --json` returns the same data: `version`, `project`, `spec`
(`package_fingerprint`, `phases_total`, `phases_closed`), `current` (`phase`, `title`, `index`,
`stage`, `round`, `cap`), `active` (`run_id`, `role`, `agent`, `mode`, `effective_mode`,
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
`gate.result`, `checkpoint.committed`, `quota.fallback`, `blocked`, `phase.closed`.

## Run archive

Every role run keeps its brief, the relay's `result.json`, event stream, stderr and the final
message under `.looprch/runs/<run_id>/` (gitignored). See
[docs/dev/debugging.md](../dev/debugging.md).
