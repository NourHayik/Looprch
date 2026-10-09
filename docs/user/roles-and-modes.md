# Roles and modes

The **Lead** is the agent chat where you run `/lr-phase`, `/lr-auto`, `/lr-resume` or
`/lr-finish`. It never does a role's work: it runs one Looprch step at a time, starts the
configured roles and posts every workflow step in the chat (see
[running-phases.md](running-phases.md#what-the-lead-tells-you)).

| Role | Responsibility |
|---|---|
| Planner | the architect: writes `plan.md`, a guide with the concept, the architecture, the decisions and every task described (what, where, how, done when), plus a todo list split into Implementer sessions sized to the Implementer's context; answers every debate item; answers the Implementer's rare blocking questions |
| Plan Debater | the Planner's opponent in a multi-round debate before any code exists: looks for what would make a cheaper Implementer fail, then judges every answer (resolved, conceded, upheld) until it agrees or the limit is reached |
| Implementer | starts right away and works through its session's todos in order, following plan.md; makes the small choices the plan leaves open and notes them; asks the Planner only when truly blocked |
| Tester | test code and gates; writes the tests the plan describes and tries to break the code and every repair |
| Reviewer | reviews the phase against plan.md and beyond it; every finding has a fix condition and an owner |

No role is limited to certain files: the roles divide the work, Looprch does not police it. The
gates, the Tester and the Reviewer judge the result. See
[running-phases.md](running-phases.md#the-plan).

Cost model: give the Planner, Plan Debater and Reviewer your strongest models, and give the Plan
Debater a different model family from the Planner (two copies of one model share their blind
spots). They decide and judge. The Implementer follows a plan that already took the design
decisions, so a cheaper model is enough; set its context size (`--context-kb`) so the Planner can
size the sessions. `looprch status --json` shows the measured `usage` (runs, minutes, and the
tokens the relays report) per role and model. The Tester tries to break the code, so it needs
more than the cheapest model: in CoreBit, a fast Tester wrote tests that passed without
exercising the behavior.

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
- the read-only Worker on a relay without read-only support (Kimi) only warns: a side run that
  changes files is discarded.

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
