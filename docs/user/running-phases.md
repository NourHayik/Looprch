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
- **Planning**: the Planner (your strongest model) writes `plan.md`, a guide like a senior
  engineer's implementation plan: overview, concept and architecture, decisions with reasons,
  numbered plan phases whose tasks say what to build, where, how and how to check it, tests,
  risks and a todo list. It does not write the code. It also splits the todos into Implementer
  sessions sized to the Implementer's context (usually one session for the whole phase).
- **Debating**: a real debate. The Plan Debater looks for what would make a cheaper Implementer
  fail (an open decision, a vague task, a missing edge case, an open rule, a requirement without
  a task, a session too large); the Planner accepts or rejects each finding and revises the plan;
  the Debater judges every answer in the next round (`resolved`, `conceded`, `upheld`), up to
  `limits.debate_rounds` passes (default 2). Serious items still disputed at the limit come to
  you (`debate_unresolved`).
- **Implementing**: the Implementer starts right away and works through its session's todos in
  order, following plan.md. Each session is one run with its own checkpoint commit. It makes the
  small choices the plan leaves open itself; only a question that truly blocks the work goes to
  the Planner, whose answer is appended to plan.md (the Debater is not involved), and the same
  Implementer session continues.
- **Testing and gating**: the Tester writes tests; Looprch then runs every declared gate itself
  and judges machine evidence (unittest counts, JUnit XML). Failures go back to the Implementer.
- **Reviewing**: the Reviewer checks the code against plan.md and `gates.json`. Changes requested
  → repair → re-test → re-review.
- **Handover**: the Implementer writes the summary; Looprch adds the file lists from git, the gate
  runs, the plan's todos and deferrals, and the debate summary.
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
[PLAN] P-001 plan: 1 todo in 1 Implementer session: .looprch/phases/P-001/plan.md
[DEBATE START] Plan sent for debate.
[TASK START] P-001-plan_debater-1: Plan Debater (debate) on kimi/kimi-k · delegate
[DEBATE COMPLETE]
Result: Changes recommended (1 finding: 1 medium).
Summary: D-1 (medium): Clarify error handling.
[PLAN UPDATE START] The Planner is updating the plan.
[PLAN UPDATED] The Planner updated the plan after the debate: .looprch/phases/P-001/plan.md
[DEBATE START] Plan sent for debate.
[TASK START] P-001-plan_debater-2: Plan Debater (rebuttal) on kimi/kimi-k · delegate
[REBUTTAL COMPLETE] The Plan Debater agrees with the revised plan.
[DEBATE ROUND 2 OF 2]
Verdicts on the Planner's answers: 1 resolved, 0 conceded, 0 upheld. New items: 0. Still open: 0.
[DEBATE CLOSED] 2 Debater pass(es), 1 item(s): 1 resolved, 0 conceded, 0 contested, 0 decided by you.
[IMPLEMENTATION START] P-001 implementation started.
[TASK START] P-001-implementer-1: Implementer (implementation) on opencode/oc/impl · delegate
[IMPLEMENTATION COMPLETE] The Implementer on opencode finished; 1 file touched.
[SESSION DONE] Implementer session 1 of 1: T-1 done.
[TESTING START] P-001 testing started.
[TESTING COMPLETE] Tester verdict: pass (codex).
[GATES START] Looprch runs the declared gates.
[GATES COMPLETE] The gate passed.
[REVIEW START] P-001 review started.
[REVIEW COMPLETE] Approved by the Reviewer on cursor.
[HANDOVER START] The Implementer writes the handover.
[HANDOVER COMPLETE] Handover accepted; Looprch added the file lists from git.
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

Repairs after failing tests or gates have a per-phase limit (`limits.repair_rounds`, default 3).
Repairs after a review do not count against it; the review limit bounds them. At the limit the
phase is `blocked: repair limit` with a summary. Continue with one more round and an instruction:

```sh
looprch resume --note "Use the existing parser instead of a new one"
```

or raise the limit: `looprch config set limits.repair_rounds 5`. Resuming always continues with
the repair, never with another review.

## The plan

`.looprch/phases/P-NNN/plan.md` is the guide; `plan.json` holds what Looprch schedules: the
todos (`T-1`, `T-2`, ...), the Implementer sessions, the map from each requirement of the phase
to the todos that deliver it, and the deferrals to later phases. Looprch checks only that it can
read the plan block; the Plan Debater, the gates, the Tester and the Reviewer judge the plan and
the code.

- **Sessions.** One session is one Implementer run. The Planner groups contiguous todos into
  sessions from the Implementer's context budget (`--context-kb` on the Implementer's role, set
  in `/lr-init`); a phase that fits one context is one session. A todo the Implementer leaves
  open gets one follow-up session.
- **Questions.** The Implementer asks the Planner (`needs_context`) only when it is truly
  blocked; small gaps it decides itself and lists in its `notes`. The answer becomes
  `## Addendum N` at the end of plan.md, and any new todos join the current session.
- **Deferrals.** Work a phase defers to a later one is listed in its handover and handed to that
  phase's Planner as `incoming-deferrals.json`.

The whole debate is in `.looprch/phases/P-NNN/debate.json`; the handover summarizes it.

## Review rounds

The Reviewer may request changes at most `limits.review_rounds` times per phase (default 3).
That is a defensive maximum, not a target: the first review is built to find everything, the
second is a safety net, and a third is for exceptional cases.

- **Round 1 is comprehensive.** The Reviewer reads every changed file (`changed-files.txt`,
  including the Tester's new files) and checks requirements, completeness, correctness,
  integration, edge cases and error handling, security, performance, maintainability and tests.
  It also gets the plan debate items that stayed contested.
- **Every finding is actionable.** It has a severity, the files, a `fix` (the condition the repair
  must meet, for all inputs, not only the example) and an `owner`: the Implementer for
  application code, the Tester for test code.
- **Repairs go straight to the Implementer.** It fixes the findings it owns (optionally reporting
  `fixed` or `not_fixed` per finding); the Tester fixes the test findings and adds tests that
  prove the repairs; the gates run again; then the re-review.
- **Round 2 is the safety net.** The re-review gets the earlier findings, the repair reports and
  the repair diff. It reports what still holds, any regression and anything round 1 missed.
- **Each round gets more time.** Review round n runs with the Reviewer timeout × (1 + 0.5 ×
  (n − 1)): with the default 60m that is 60m, 90m and 2h. The brief states the time budget.
- **The final review** (round `limits.review_rounds`) still lists every remaining issue but
  requests changes only for high or critical defects. If it approves, its medium and low findings
  go into `handover.md` under "Open review notes (approved, not repaired)".

If the final review still requests changes, Looprch stops and asks you (`[DECISION NEEDED]`):

| Option | What happens |
|---|---|
| `repair_and_review` | the Implementer repairs, tests and gates run, then one more review (the new final one) |
| `repair_and_handover` | the Implementer makes a final repair, tests and gates must pass, then the phase goes to handover **without another review**: `[REVIEW SKIPPED]`, and `handover.md` gets an "Open review findings (final repair, not re-reviewed)" section |
| `pause` | the phase pauses; `looprch resume` asks again |

Reaching this question means the earlier rounds missed something, so look at the review reports
before you answer. Change the limit with `looprch config set limits.review_rounds 2`.

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
