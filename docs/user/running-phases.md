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

## What the Lead tells you

The Lead never works silently. After every `looprch next`, `record` and `dispatch` it posts the
progress lines Looprch returns, then one `Now: … Next: …` line, so you always see what just
happened, what runs now and what comes next. A phase looks like this (shortened):

```text
[PHASE START] P-001 "Identifier foundation"
[PREFLIGHT COMPLETE] P-001 checks passed (risk high).
[PLANNING START] P-001 planning started.
[TASK START] P-001-planner-1: Planner (planning) on cursor/cursor-plan · direct
[PLANNING COMPLETE] Initial plan completed by the Planner on cursor: .looprch/phases/P-001/plan.md
[DEBATE START] Plan sent for debate.
[TASK START] P-001-plan_debater-1: Plan Debater (debate) on kimi/kimi-k · delegate
[DEBATE COMPLETE]
Result: Changes recommended (1 finding: 1 medium).
Summary: D-1 (medium): Clarify error handling.
[PLAN UPDATE START] The Planner is updating the plan.
[PLAN UPDATED] The Planner updated the plan after the debate: .looprch/phases/P-001/plan.md
[IMPLEMENTATION START] P-001 implementation started.
[ISSUE]
Task P-001-implementer-1 (Implementer on opencode) failed.
Reason: failed: boom
Action: Retry with the same agent.
[RETRY] P-001-implementer-2: Implementer (implementation) on opencode/oc/impl · delegate · attempt 2
[IMPLEMENTATION COMPLETE] The Implementer on opencode finished; 1 file touched.
[TESTING START] P-001 testing started.
[TESTING COMPLETE] Tester verdict: pass (codex).
[GATES START] Looprch runs the declared gates.
[GATES COMPLETE] The gate passed.
[REVIEW START] P-001 review started.
[REVIEW COMPLETE] Approved by the Reviewer on cursor.
[HANDOVER START] The Implementer writes the handover.
[HANDOVER COMPLETE] Handover accepted; its file lists match git.
[CLOSING START] Ticking todo.md, then commit, merge and tag.
[PHASE COMPLETE] P-001 closed and merged (tag looprch/P-001).
Now: phase closed. Next: P-002.
```

A debate without findings reads `Result: No changes recommended. Original plan accepted.` Other
lines report fallbacks (`[FALLBACK] Implementer: opencode/oc/impl replaced by codex/codex-impl`),
waits for quota or rate limits (`[WAITING]`), checkpoints, warnings, questions you must answer
(`[DECISION NEEDED]`, `[DECISION]`) and stops (`[BLOCKED]` with the reason and the fix). Command
output and tool-by-tool activity are not posted. See [status-and-logs.md](status-and-logs.md) for
the full list.

## Repair limit

Test and review repairs share a per-phase limit (`limits.repair_rounds`, default 3). At the limit
the phase is `blocked: repair limit` with a summary. Continue with one more round and an
instruction:

```sh
looprch resume --note "Use the existing parser instead of a new one"
```

or raise the limit: `looprch config set limits.repair_rounds 5`. Resuming always continues with
the repair, never with another review.

## Review limit

The Reviewer may request changes at most `limits.review_rounds` times per phase (default 3).
Looprch tries to get everything right in the first pass:

- The Implementer reviews its own diff against the Reviewer's criteria before it reports, and a
  repair fixes the root cause and every other occurrence of the same defect.
- The first review must report every finding at once. `changes_requested` needs at least one
  `medium`, `high` or `critical` finding; low findings are notes on an approval.
- A re-review gets the earlier findings. It checks that they are fixed and looks for regressions
  in the repair. It raises new findings on unchanged code only when they are high or critical.
- The brief tells the last allowed review that it is the final one. It requests changes only for
  high or critical defects.

If the final review still requests changes, the Implementer makes one final repair, and the Tester
and gates must pass again. The phase then goes to handover **without another review**. The
progress line `[REVIEW SKIPPED]` reports this, and `handover.md` gets an
"Open review findings (final repair, not re-reviewed)" section. Change the limit with
`looprch config set limits.review_rounds 2`.

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
