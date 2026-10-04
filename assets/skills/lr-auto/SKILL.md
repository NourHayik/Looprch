---
name: lr-auto
description: Looprch - run SEV3 phases one after another until the closure phase, then stop. Use when the user runs /lr-auto.
---
# /lr-auto

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

Scope: `auto`. When the action is `phase_closed`, report it and **continue** with step 1. Looprch
stops by itself before the closure phase (`stop_before_closure`); the user then runs `/lr-finish`.

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

## Reporting

Never work silently: the user must always see what just happened, what runs now and what comes next.

- `looprch next`, `looprch record` and `looprch dispatch` return `progress`: tagged status lines such as `[PHASE START]`, `[PLANNING COMPLETE]`, `[DEBATE COMPLETE]`, `[TASK START]`, `[ISSUE]`, `[RETRY]`, `[FALLBACK]`, `[WAITING]`, `[GATES COMPLETE]` or `[BLOCKED]`. After each of these commands, post every `progress` line in the chat exactly as given (a multi-line entry stays multi-line) before you run anything else.
- Then add one line `Now: <what runs now>. Next: <what follows>`, taken from the action you are about to carry out (for `run_role`: role, task, agent and model; for `wait`: until when). While polling `await_run`, post it once and again only when new `progress` lines arrive.
- When the loop stops, end with what the user has to do: the `hint` of `blocked`, `/lr-finish` for `stop_before_closure`, `/lr-resume` for `paused`. After `phase_closed`, say `Next:` according to this skill's rule for closed phases.
- Report workflow steps, decisions, failures and results only. Do not post raw command output, JSON or tool-by-tool activity, and never invent a status line: an empty `progress` list needs only the `Now/Next` line.
<!-- loop:end -->
