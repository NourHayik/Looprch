# Running phases

| Skill | Scope | Stops |
|---|---|---|
| `/lr-phase` | `phase` | after the current phase closes |
| `/lr-auto` | `auto` | before the `kind: closure` phase |
| `/lr-finish` | `finish` | after the closure phase and the final project closure |
| `/lr-pause` | | at the next step boundary |
| `/lr-resume` | remembered | continues the remembered scope |

## One phase

```text
preflight → planning → debating → [synthesizing] → [plan approval] → implementing
→ testing → gating → reviewing → handover → closing → closed
```

- **Preflight** (seconds): config valid, package still verified with the recorded fingerprint,
  toolkit trusted, gate commands acknowledged, relays and CLIs present, git clean on the base
  branch. The first phase also offers the baseline commit.
- **Planning / debating**: exactly one Plan Debate pass; findings go back to the same Planner
  session for synthesis.
- **Implementing**: one sequential Implementer writes application code only.
- **Testing and gating**: the Tester writes tests; Looprch then runs every declared gate itself
  and judges machine evidence (unittest counts, JUnit XML). Failures go back to the Implementer.
- **Reviewing**: the Reviewer checks the code and `gates.json`. Changes requested → repair →
  re-test → re-review.
- **Handover**: the Implementer writes the final handover; Looprch compares its file lists with
  `git diff --name-status` since the phase base.
- **Closing**: Looprch ticks `phases/todo.md`, commits, merges and tags.

## Repair limit

Test and review repairs share a per-phase limit (`limits.repair_rounds`, default 3). At the limit
the phase is `blocked: repair limit` with a summary. Continue with one more round and an
instruction:

```sh
looprch resume --note "Use the existing parser instead of a new one"
```

or raise the limit: `looprch config set limits.repair_rounds 5`.

## Optional approvals

```sh
looprch config set approvals.plan high-risk    # never | high-risk | always
looprch config set approvals.merge always
```

`high-risk` asks for phases with risk `high` or `critical`. Plan approval offers approve or
revise (with your text); merge approval offers merge or hold (pause).

## Pause, interruption, restart

`/lr-pause` stops at the next step boundary; a running role finishes first. If your agent, the
terminal or the machine stops, simply run `/lr-resume` (or any loop skill): Delegate runs keep
going in the background and are recorded when they finish; a run that vanished without a result
is retried in the same session.
