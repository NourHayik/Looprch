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

Repairs after failing tests or gates have a per-phase limit (`limits.repair_rounds`, default 3).
Repairs after a review do not count against it; the review limit bounds them. At the limit the
phase is `blocked: repair limit` with a summary. Continue with one more round and an instruction:

```sh
looprch resume --note "Use the existing parser instead of a new one"
```

or raise the limit: `looprch config set limits.repair_rounds 5`. Resuming always continues with
the repair, never with another review.

## The phase contract

The Planner delivers the plan together with a contract, `.looprch/phases/P-NNN/contract.json`.
It lists **obligations** (a rule or behavior, the single place that enforces it, what the Tester
must prove, and the gates that prove it) and **deferrals** (what a later phase delivers, which
phase, and how this phase fails closed until then). Looprch checks it before the debate:

- every requirement id the SEV3 manifest maps to the phase is covered by an obligation or a
  deferral, and the ids and gate ids exist;
- every deferral targets a later phase;
- deferrals that closed phases made to this phase (`incoming-deferrals.json`) are covered.

The Plan Debater challenges the plan and the contract (missing requirements, trust sources,
dependency direction, enforcement that only recognizes known bad cases, untestable rules,
missing failure behavior and deferrals, places where the Implementer would have to invent a
design). The synthesis must accept or reject every debate finding; an accepted one names the
obligations that carry it.

The contract also carries **work packages**: the Planner's breakdown of the implementation into
small, ordered packages, each with the exact files (and what each contains: classes, signatures,
schemas, keys), ordered steps and `done_when` checks. Every obligation must be built by a package,
and no package may exceed 25 steps or 25 files. The idea is that the expensive model you
configure as Planner makes every design decision, and a cheaper model as Implementer executes
them literally.

The same contract is the input of every later role:

- the **Implementer** runs once per work package, in order (`[PACKAGE DONE]`, one checkpoint
  commit per package), and asks the Planner (`needs_context`) instead of inventing a design a
  package leaves open;
- the **Tester** returns a verification for every obligation and deferral, naming the testcases
  that prove it. After the gates, Looprch matches those names against the passing testcases of
  its own gate run; a claim it cannot match goes back to the Tester alone (`[EVIDENCE MISMATCH]`);
- the **Reviewer** reports `met` or `not_met` for every obligation in round 1, classifies every
  finding by `cause` (`implementation`, `plan`, `requirement`, `cross_phase` or `test`) and names
  the obligations it concerns.

`handover.md` ends with the contract status and the deferrals to later phases.

## Review rounds

The Reviewer may request changes at most `limits.review_rounds` times per phase (default 3).
That is a defensive maximum, not a target: the first review is built to find everything, the
second is a safety net, and a third is for exceptional cases.

- **Round 1 is comprehensive.** The Reviewer reads every changed file (the diff includes the
  Tester's new files), walks every plan step and requirement id, and checks a fixed list:
  requirements and acceptance criteria, plan compliance, completeness, correctness, integration
  and cross-phase contracts, regressions, edge cases and error handling, security, performance,
  maintainability, tests, build and runtime, and production readiness. The report starts with a
  `## Coverage` section saying what was checked for each area.
- **Every finding is actionable.** It has a severity, the files, a `fix` (the condition the repair
  must meet) and an `owner`: the Implementer for application code, the Tester for test code.
  `changes_requested` needs at least one `medium`, `high` or `critical` finding; low findings
  are notes on an approval. Every issue goes into the findings list, not only into the prose.
- **Repairs are accounted for and verified.** The Implementer fixes the findings it owns and
  reports a `resolutions` entry for each one: `fixed` (with the files the repair changed;
  Looprch rejects a `fixed` whose files did not change since the review), `not_fixed`, or
  `needs_design` when the contract does not say how to repair it. The Tester then fixes the
  test-owned findings and tries to falsify every other repair: it tests the rule in the `fix`
  and the obligations, with an input class neither the Reviewer nor the Implementer named, and
  returns a verification naming the testcases. A finding that is not fixed is a Tester failure,
  so it goes back to the Implementer before the next review.
- **Repairs fix the rule, not the example.** A finding names the broken rule, and its `fix`
  states the rule for all inputs and the known variants. High and critical findings list
  `checks`: the acceptance checks of the repair, one testable condition each. The `fix` and the
  checks do not change between rounds: a re-review judges the same conditions, and a new way to
  break the rule is a new finding marked `related` to the earlier one.
- **A repair is proven by a new test.** The Tester names, per check, the testcases that prove it.
  A testcase that already passed on the tree where the Reviewer found the defect cannot prove the
  repair, so Looprch requires at least one cited testcase per check that did not pass there; a
  claim without one goes back to the Tester (`[EVIDENCE MISMATCH]`).
- **The Planner designs every repair; the Implementer executes it.** Before the Implementer
  repairs, the Planner turns the review's findings into repair packages (at most 5 findings
  each, with exact files, steps and checks), and the Implementer executes one package per run
  (`[REPAIR DESIGN]`, `[PACKAGE DONE]`). For findings the Reviewer traced to the plan, a missed
  requirement or a later phase, findings a re-review reports as `unfixed`, `related` findings,
  and `needs_design` resolutions, the design also amends the contract to define the enforcement. When the design covers a high or critical finding, or replaces a design
  that did not hold, the Plan Debater challenges it once (`[DESIGN DEBATE COMPLETE]`) and the
  Planner revises it if needed. The Implementer, Tester and Reviewer get the amended contract.
- **Round 2 is the safety net.** The re-review gets the open findings, the repair reports and the
  repair diff (from the tree it last reviewed to the current one). It says `fixed` or `unfixed`
  for every earlier finding, looks for regressions and over-fixes, and reports anything round 1
  missed. Every re-review finding says whether it is `unfixed`, a `regression` or `missed`; the
  progress line `[REVIEW COMPLETE]` shows these counts.
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
