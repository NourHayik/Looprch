# Concepts

## SEV3 package

A SEV3 package lives at the root of your project: `phases/manifest.json` (phases, gates,
ownership), `phases/en/P-NNN.md` (phase sources), `requirements/` and the single tracker
`phases/todo.md`. Looprch reads it with its own trusted copy of the SEV3 toolkit 1.2.0 and
refuses packages whose toolkit files differ. Looprch never edits the specification; it only
ticks boxes in `phases/todo.md` after verified evidence.

"Specification verified" (the toolkit's check) never means "application verified". Only the gate
runs Looprch performs on your code are evidence for the application.

## Roles

| Role | Does | Writes |
|---|---|---|
| Lead | Your agent running `/lr-*`; follows `looprch next` | nothing in `.looprch/` |
| Planner | Implementation plan from the exact-source packet | `plan.md` (through Looprch) |
| Plan Debater | One critical pass over the plan, read-only | `debate.md` |
| Implementer | The single sequential author of application code | application code |
| Tester | Owns test code and every declared gate | tests |
| Reviewer | Checks the actual code and evidence, read-only | `review.md` |
| Worker | Read-only advisory helper (`/lr-worker`) | nothing |

## Direct and Delegate

- **Direct**: the agent the Lead runs in executes the role as its own native subagent; you choose
  only the model.
- **Delegate**: another agent CLI runs the role through its delegate-skills relay; you choose the
  agent and the model.
- If a role is Direct for agent X but the Lead now runs in agent Y, Looprch runs it through
  `X-delegate` with the same model and shows `direct→delegate` in status. If that relay or CLI is
  missing, Looprch stops with a clear message.

## Briefs, packets and results

For every role run Looprch writes one **brief** (`.looprch/runs/<run_id>/brief.md`): the role
text, the inputs to read (always the SEV3 **packet** for the role, never truncated), the task,
any repair findings and the **output contract**. Every role ends its final message with a fenced
`looprch-result` JSON block that Looprch validates.

## State

Everything lives in plain files in `.looprch/`: `config.json` (your choices), `state.json`
(where execution is), `events.jsonl` (append-only journal), `phases/P-NNN/` (plans, reports,
gates.json, handover). Runtime files (`runs/`, `packets/`, test evidence) are gitignored.

## Phases and gates

A phase closes only when every declared gate passed on the final snapshot of your working tree,
the Tester's verdict is pass, the Reviewer approved, and the Implementer's handover lists exactly
the files git shows. Then Looprch ticks `phases/todo.md`, commits, merges `looprch/P-NNN` into
your base branch with `--no-ff` and tags `looprch/P-NNN`.
