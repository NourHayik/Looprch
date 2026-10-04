---
name: lr-finish
description: Looprch - run the SEV3 closure phase and the final project closure (production-readiness tick and final report). Use when the user runs /lr-finish after all implementation phases are closed.
---
# /lr-finish

You are the **Lead**. The `looprch` CLI owns the workflow state; you execute one step at a time.

Your host id (use it as `<host>` below):

| You are running in | `<host>` |
|---|---|
| Codex | `codex` |
| Cursor | `cursor` |
| Antigravity | `agy` |
| Kimi Code | `kimi` |
| Hermes | `hermes` |
| OpenCode | `opencode` |
| Grok Build | `grok` |

Scope: `finish`. When the action is `phase_closed`, report it and **continue** with step 1; the
final step is `project_done`, which points at `.looprch/FINAL_REPORT.md`: show the user its path
and its summary lines. If Looprch answers `blocked` with code `phases_remaining`, tell the user to
run `/lr-auto` first.

<!-- loop:begin -->
## Loop

Repeat until an action tells you to stop. Keep no workflow state in your memory: `looprch next` is the only source of the next step, so a new chat or a restart simply continues.

1. Run `looprch next --host <host> --scope <scope> --json` and read `action`.
2. Do exactly what the action says:
   - `run_role` with `"mode": "delegate"`: run `command` (`looprch dispatch <run_id> --json`). If it reports `"status": "running"`, that is normal; go back to step 1.
   - `run_role` with `"mode": "direct"`: start your native subagent `subagent` with model `model` and give it only this instruction: "Read and follow the brief at `<brief>` exactly." Never do the role's work yourself. When it finishes, pipe its complete final message, unchanged, into `record_command` (add `--session <id>` if your subagent tool returned an id). `spawn_hint` says how for your host.
   - `await_run`: run `command` (`looprch dispatch --wait <run_id> --json`).
   - `run_gates`, `checkpoint`, `wait`: run `command` and go back to step 1.
   - `ask_user`: ask the user `question` with `options` verbatim, then run `looprch answer <question_id> <option_id>` (add `--text "<their words>"` when they explain a revision).
   - `phase_closed`: tell the user the phase and tag, then follow this skill's rule for closed phases.
   - `stop_before_closure`, `project_done`, `paused`: tell the user and stop.
   - `blocked`: tell the user `reason` and `hint`, and stop. Never work around a block.
3. Never edit `.looprch/` or `phases/todo.md`, never commit, never tick boxes, never replace a role.
4. After a phase closes, use your host's real context compaction if it has one; never invent a summary of results.
<!-- loop:end -->
