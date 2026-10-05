---
name: lr-init
description: Looprch - initialize this project: readiness checks, SEV3 package discovery and trust, gate-command acknowledgement, and the role/agent/model configuration conversation. Use when the user runs /lr-init.
---
# /lr-init

You set up Looprch for this project once. Every choice is persisted by a `looprch` command; never
edit `.looprch/config.json` yourself. Never invent a model id: offer only ids from
`looprch models <agent>` or ids the user types.

Your host id: Codex `codex`, Cursor `cursor`, Antigravity `agy`, Kimi Code `kimi`, Hermes
`hermes`, OpenCode `opencode`, Grok Build `grok`.

## 1. Readiness

Run `looprch doctor --json`. Explain every `fail` and `warn` in plain words with its `fix`.
Offer to fix, after the user confirms each one:
- missing relay: `looprch install-relay <agent> --yes`
- no git repository: `looprch init git` (the baseline commit is offered later, at the first phase)
- not attached or broken links: tell the user to run `looprch add .` in a terminal

## 2. SEV3 package

Run `looprch init discover --json`.
- `ok: false`: report `errors` and stop. The package must be at the project root; a modified
  toolkit is never accepted.
- Show `project`, the number of phases, the closure phase, and say clearly: the specification was
  verified, the application is not verified until the gates pass.
- Show `gate_commands` (each `argv0` and how many gates use it). Ask the user to confirm that
  Looprch may run them. If yes: `looprch init ack-gates --manifest-sha256 <manifest_sha256>`.

## 3. Roles

Run `looprch config set lead_host <host>` first. Then, for each role (Planner, Plan Debater,
Implementer, Tester, Reviewer, Worker), ask:
1. Which agent? (only agents enabled in this project; `looprch config show --json` lists them)
2. Direct or Delegate? Direct means your own native subagent runs the role (only for your own
   host, `<host>`); Delegate means another agent CLI runs it through delegate-skills. Hermes can
   only be the Lead, never a Delegate target.
3. Which model? Run `looprch models <agent> --json` and offer its `models`. If the list is empty
   or failed, ask the user to type the exact id. OpenCode models are `provider/model`.
4. Optional: reasoning effort, timeout (Implementer default `2h`), approved fallbacks
   (agent + mode + model, tried in order when usage limits are exhausted).

Persist each answer:
- `looprch config set-role <role> --mode <direct|delegate> --agent <agent> --model <model> [--effort <e>] [--timeout <dur>]`
- `looprch config add-fallback <role> --mode <m> --agent <agent> --model <model>`
Role keys: `planner`, `plan_debater`, `implementer`, `tester`, `reviewer`, `worker`.

Optional settings, only if the user asks: `looprch config set approvals.plan high-risk`,
`approvals.merge`, `limits.repair_rounds`, `limits.review_rounds` (reviews that may request
changes per phase, default 3), `gates.env.<NAME> <value>`, `context_kb.<agent> <KB>`.

## 4. Finish

Run `looprch config validate --json` and fix any error with the user. Then `looprch status` and
tell the user the next step: `/lr-phase` (one phase) or `/lr-auto` (all phases until closure).
