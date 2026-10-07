# Roles and modes

The **Lead** is the agent chat where you run `/lr-phase`, `/lr-auto`, `/lr-resume` or
`/lr-finish`. It never does a role's work: it runs one Looprch step at a time, starts the
configured roles and posts every workflow step in the chat (see
[running-phases.md](running-phases.md#what-the-lead-tells-you)).

| Role | Responsibility |
|---|---|
| Planner | the implementation-ready plan and its contract (obligations and deferrals); answers context requests and writes repair designs as contract amendments |
| Plan Debater | challenges the plan and contract once before any code exists, and repair designs for serious findings that a code repair did not settle; read-only |
| Implementer | application code against the contract; never tests |
| Tester | test code and gates; verifies every obligation and tries to falsify every repair; never application code |
| Reviewer | reviews the phase against the contract and beyond it; classifies each finding by cause; read-only |

All of them work from the same `contract.json`; see
[running-phases.md](running-phases.md#the-phase-contract).

## Configuring a role

```sh
looprch config set-role <role> --mode direct|delegate --agent <agent> --model <model> \
  [--effort <level>] [--timeout 2h] [--context-kb <KB>] [--max-parallel <n>]
looprch config add-fallback <role> --mode delegate --agent <agent> --model <model>
looprch config clear-fallbacks <role>
```

Roles: `planner`, `plan_debater`, `implementer`, `tester`, `reviewer`, `worker`.

Rules checked on every change:
- the agent must be enabled in the project (`looprch add . --agents <agent>`);
- a Direct role needs an agent with Direct support (Codex, Cursor, OpenCode in this version);
- a Delegate role needs that agent's relay (`looprch install-relay <agent>`); Hermes has none;
- OpenCode models are `provider/model`;
- read-only roles (Plan Debater, Reviewer, Worker) on a relay without read-only support (Kimi)
  only warn: Looprch still compares git status before and after the run.

## Which mode runs

| Configured | Lead runs in | Runs as |
|---|---|---|
| Direct on X | X | your native subagent `lr-<role>` with the configured model |
| Direct on X | Y | `X-delegate` relay, same model, status shows `direct→delegate` |
| Delegate on X | any | `X-delegate` relay |

Then the usage policy may pick a fallback (see [quota-and-fallbacks.md](quota-and-fallbacks.md)).

## Effort and timeouts

`--effort` is passed as `--effort` (Codex, Antigravity, Grok) or `--variant` (OpenCode). Cursor
and Kimi relays have no effort flag; Looprch records a warning and runs without it. Every
Delegate run gets `--timeout` (default 60m, Implementer 2h, Worker 30m). Review rounds get more
time each round: round n runs with the Reviewer timeout × (1 + 0.5 × (n − 1)), so 60m, 90m and 2h
by default; the brief states the budget, also for Direct runs.

## Sessions

Within a phase, repairs, the Planner's synthesis and the handover resume the same session
(`--session` / `--conversation`). Each phase starts new sessions. If a resume is impossible the
role gets a fresh session with the full packet plus earlier outputs.

## Worker

`/lr-worker <question>` runs a read-only Worker. Its answer is saved under
`.looprch/phases/<phase>/workers/` and is advisory: it never replaces a requirement or satisfies
a gate. At most `roles.worker.max_parallel` (default 3) Workers run at once.
