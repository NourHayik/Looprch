# Command reference

All commands accept `--json` (stable output for skills and scripts) and most accept
`--root <dir>` (default: the git root of the current directory). Exit codes: 0 ok, 1 error,
2 usage error, 3 project lock busy.

## Agent skills

| Skill | Does |
|---|---|
| `/lr-init` | readiness, SEV3 discovery and trust, gate acknowledgement, role configuration |
| `/lr-doctor` | readiness report with fixes |
| `/lr-status` | current phase, stage, active role, blockers, next action |
| `/lr-phase` | run the current phase, then stop |
| `/lr-auto` | run phases until the closure phase |
| `/lr-pause` | pause at the next step boundary |
| `/lr-resume` | clear pause/block/wait and continue |
| `/lr-review [P-NNN]` | extra read-only review, never changes status |
| `/lr-finish` | closure phase and final project closure |
| `/lr-worker <question>` | read-only advisory Worker |
| `/lr-e2e-test-init` | set up (three questions, then `looprch e2e init`), change, enable or disable the optional TesterArmy e2e gate |

Invocation per agent: Codex `$lr-init`, Kimi Code `/skill:lr-init`, all others `/lr-init`.

## Installation

| Command | Purpose |
|---|---|
| `looprch install [--from <dir>]` | install into `~/.looprch/versions/<v>`, switch `current`, write the shim |
| `looprch update [--to <v>] [--from <dir>] [--yes]` | install a new version side by side, self-test, switch |
| `looprch rollback` | switch back to the previous version |
| `looprch uninstall [--yes]` | remove the shim and `~/.looprch/` |
| `looprch version` | version, protocol, toolkit |
| `looprch self-test` | offline integrity checks |

## Projects

| Command | Purpose |
|---|---|
| `looprch add [path] [--agents a,b] [--yes] [--copy]` | attach agents, write skills and files |
| `looprch remove <agent>` | remove an agent's Looprch files |
| `looprch list` | registered projects |
| `looprch doctor [--quick]` | readiness checks (`checks[]` with `id`, `status`, `summary`, `fix`) |
| `looprch init discover [--accept-fingerprint]` | SEV3 discovery, trust, verification, fingerprints |
| `looprch init ack-gates --manifest-sha256 <sha>` | acknowledge gate commands |
| `looprch init git [--baseline]` | create the repository (and the baseline commit) |
| `looprch config show / validate` | print or validate the config |
| `looprch config set-role <role> --mode --agent --model [--effort] [--timeout] [--context-kb] [--max-parallel]` | configure a role |
| `looprch config add-fallback <role> --mode --agent --model ...` | add an approved fallback |
| `looprch config clear-fallbacks <role>` | remove fallbacks |
| `looprch config set <key> <value>` | `lead_host`, `limits.*` (`repair_rounds`, `review_rounds`, `debate_rounds`, `run_attempts`, `quota_wait_minutes`, `dispatch_max_wait`, `expansion_rounds`), `approvals.plan/merge`, `git.phase_branches`, `gates.env.<NAME>`, `context_kb.<agent>`, `integrations.commit_generated`, `integrations.e2e.enabled` |
| `looprch e2e init [--provider none\|openrouter\|openai\|anthropic\|google\|deepseek\|gateway\|openai-compatible] [--model <id>] [--url <url> \| --start "<cmd>" [--ready-url <url>]] [--base-url <url>] [--phases ...] [--install] [--force] [--enable] [--yes]` | set up e2e in one step: install the packages, write `e2e.config.ts`, the `.env.e2e` keys file (gitignored) and a first test, and save the gate; asks in a terminal when flags are missing |
| `looprch e2e status` | the optional e2e gate: configured, enabled, setup problems |
| `looprch e2e configure [--config] [--bin] [--timeout] [--arg=<x>]... [--require-env NAME]... [--env NAME=value]... [--phases all\|P-NNN,...] [--enable]` | check the e2e setup (Node, binary, config, variables, dry-run list) and save it |
| `looprch e2e enable` / `looprch e2e disable` | turn the gate on (only after configure) or off (keeps the configuration) |
| `looprch models <agent> [--refresh]` | models from delegate-setup discovery |
| `looprch install-relay <agent> [--yes]` | install a delegate-skills relay globally |

## Execution (used by the skills)

| Command | Purpose |
|---|---|
| `looprch next --host <agent> [--scope phase\|auto\|finish]` | the single next action |
| `looprch dispatch <run_id> [--max-wait 10m]` | start a Delegate run (detached) and wait up to max-wait |
| `looprch dispatch --wait <run_id>` | wait again for a running Delegate run |
| `looprch record <run_id> --stdin [--session <id>]` | record a Direct subagent's final message |
| `looprch check <run_id> [--stdin \| --file <path>]` | used by roles: check a report against Looprch's acceptance checks before ending, without side effects (default: the run's `report.md`) |
| `looprch gates run [--phase P-NNN]` | run the phase gates |
| `looprch checkpoint` | commit the pending stage checkpoint |
| `looprch answer <question_id> <option_id> [--text]` | answer an `ask_user` action |
| `looprch wait [--max 10m]` | sleep until a usage-limit wait ends |
| `looprch pause` / `looprch resume [--note]` | pause; clear pause/block/wait |
| `looprch worker "<question>" --host <agent>` | start a Worker run |
| `looprch review [P-NNN] --host <agent>` | start an ad hoc review run |
| `looprch status` / `looprch log [--phase] [-n] [--type]` | observability |

## next actions

`run_role`, `await_run`, `run_gates`, `checkpoint`, `wait`, `ask_user`, `paused`, `blocked`,
`phase_closed`, `stop_before_closure`, `project_done`. Field lists:
[docs/dev/lifecycle-state-machine.md](../dev/lifecycle-state-machine.md).
