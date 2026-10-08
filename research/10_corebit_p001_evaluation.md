# CoreBit P-001 evaluation (baseline for 0.7.0)

Date: 2026-10-08. Evidence: `/var/www/html/Corebit/.looprch/` (read-only), git history of
`looprch/P-001`. CoreBit is a test project; its defects are evidence about Looprch.

## Run summary

| Item | Value |
|---|---|
| Looprch version | phase started on 0.6.0; 0.6.1 to 0.6.3 shipped during the run |
| Roles | Planner, Plan Debater, Reviewer: codex `gpt-6-sol`; Implementer: opencode `deepseek-v4.1-flash`; Tester: cursor `grok-4.7-high` |
| State at evaluation | `in_progress`, stage `gating`, round 10, 13 open review findings, not closed |
| Runs issued | 61: planner 8 (planning 2, synthesis 1, context_answer 5), plan_debater 2, implementer 37 (10 work packages, 27 repairs), tester 12, reviewer 2 |
| Rejected results | 2 (planner-1: obligation without package; tester-10: missing verifications) |
| Gate runs | 10 (4 passed) |
| Agent wall time | about 7.7 h (implementer 3.9 h, tester 2.4 h, reviewer 0.5 h, planner 0.75 h, debater 0.2 h) |
| Token usage | not measurable: relays write only `exit.json` (`code`, `signal`, `at`) |

## Planning

The first plan (contract r0) had 17 obligations, 5 deferrals and 6 work packages. Packages named
files and short content sketches, but left closed rules undecided at every trust boundary:

- WP-5 "parse every app PHP file... collect import" with no complete allowed database-call grammar
  (later R-9, design debate D-3).
- Command input schemas: "draft 2020-12, `additionalProperties: false`" with no positive keyword
  grammar (later R-12, design debate D-6).
- Authority binding: no principal legal-entity set or nullable-scope rule (later R-11, design
  debate D-5).

These are design decisions. Leaving them open made the cheap Implementer invent them, and it
invented denylists. **Classification: incomplete plan.**

## Plan Debate

One pass, 15 findings (critical 1, high 5, medium 9). The Planner accepted all 15 in one line each;
there was no rejection, no discussion and no check by the Debater.

The acceptances changed little: contract r1 still had **17 obligations** (deferrals 5 to 6, work
packages 6 to 10, D-14 only). D-3 (fixture identity), D-5 (registry loader and handler interface)
and D-9 (unknown/reconciling result states) were accepted in prose but added no obligation or
interface. D-4 ("complete source-root architecture scan for table ownership") was accepted, then
implemented as a denylist and returned as R-9 `unfixed` in both review rounds and as R-18/R-21
`missed`.

**Classification: the debate is not a debate.** `lifecycle.ts` runs one Debater pass and one
synthesis; a rejection needs only a non-empty reason; an acceptance is never checked against a
contract change; the Debater never sees the final plan. Both roles were the same model.

## Implementation

The Implementer followed the packages literally (no invented architecture beyond what the
packages left open). Where a package left a closed rule open it chose the narrowest reading of the
reviewer's example. Example: R-9 repair `2e92704` flags `db()`, `app('db')`, `resolve('db')`; the
reviewer's next probe `app()->make('db')->statement(...)` passes. **Classification: correct
execution of an insufficient instruction.**

## Testing

The Tester verified each repair against the reviewer's listed checks (R-9 check 2 plants only
`app('db')` and `resolve('db')`; R-12 checks cover nonexistent type, wrong draft, extra property).
The tests are real and fail without the code, but they assert the example, not the rule. Looprch
could only check that cited testcases exist and pass. **Classification: weak tests derived from
examples; verification true for the examples and false for the rule.**

## Review

| Round | Findings | Severities | Causes | Prior |
|---|---|---|---|---|
| 1 | 16 | high 11, medium 5 | implementation 14, test 1, plan 1 | - |
| 2 | 13 | high 10, medium 3 | implementation 7, test 3, plan 3 | 9 fixed, 7 unfixed; 6 missed |

Round 1 was broad (every obligation got a `contract_review`, coverage section present) but
classified closed-rule defects as `implementation`. R-9, R-11 and R-12 were design gaps: the
design debate after round 2 (D-3, D-5, D-6) states "leaving accepted schemas and inputs to
Implementer invention". Six round-2 findings were `missed` in round 1, three of them related to
round-1 lineages (R-18, R-20 to R-9/R-7). **Classification: comprehensive in coverage, wrong in
ownership for boundary rules, which sent design work to the cheap model.**

## Why "fixed", then "verified", then "unfixed"

| Finding | Repair claim | Tester claim | Reviewer round 2 | Root cause |
|---|---|---|---|---|
| R-7 JUnit trace validity | fixed (map, path, kind checks) | verified | `<evil>` root accepted | incomplete rule; tests of examples |
| R-9 database bypass | fixed (three call forms) | verified (two forms) | `app()->make('db')` passes | denylist where the plan needed a closed grammar |
| R-12 schema admission | fixed (`additionalProperties:false`) | verified (three examples) | `patternProperties` admits undeclared fields | no positive keyword grammar in the contract |
| R-14 receipt scope | fixed (hashes) | verified | tenant scopes collide in the test | weak test (owner tester) |

Common chain: the plan left the rule open, the reviewer classified the gap as `implementation`,
the repair and the test both followed the example, Looprch's evidence check (named testcase passes)
was satisfied, and only an expensive re-review found the next variant. A fail-before/pass-after
check would not have caught it: a test of the example also fails before the fix.

## Cost

- Every review round sent every Implementer finding to a Planner repair design (D-25), then one
  Implementer run per repair package: 27 repair runs for 16 + 13 findings.
- 37 Implementer runs each started a fresh agent and listed the same 106 KB SEV3 packet.
- Expensive reasoning was repeated where the plan had deferred design: the design debate after
  round 2 resolved what the plan debate should have closed before implementation.
- Token data is not recorded by Looprch, but the relays write it: cursor in `result.json`
  (`usage`), codex in `relay/events.jsonl` (`turn.completed.usage`), opencode per step
  (`part.tokens`). Measured from those files:

| Role (model) | Runs | Uncached input | Cached input | Output |
|---|---:|---:|---:|---:|
| Implementer (deepseek-v4.1-flash) | 37 | 5.8 M | 368.7 M | 1.09 M |
| Tester (grok-4.7-high) | 12 | 4.5 M | 70.3 M | 0.55 M |
| Planner (gpt-6-sol), per-turn reading | 8 | 5.0 M | 52.9 M | 0.63 M |
| Reviewer (gpt-6-sol), per-turn reading | 2 | 1.1 M | 31.2 M | 0.09 M |
| Plan Debater (gpt-6-sol), per-turn reading | 2 | 0.2 M | 3.3 M | 0.03 M |

  Codex runs of one role resume one thread; if its `turn.completed.usage` is cumulative for the
  thread, the expensive-model totals are the last run's figures instead (Planner 1.5 M uncached,
  12.7 M cached, 0.14 M output). Either way, 5 of the 8 Planner runs (and most of its output) were
  repair designs after the reviews, not the plan: the expensive model spent more on repairing
  than on planning.

## Systemic weaknesses (input to 0.7.0)

1. The debate is one-shot and unchecked (D-26).
2. The contract does not decide closed rules, interfaces, or the tests to write; package detail is
   prompt-only (D-27).
3. Nothing measures where a cheap model would have to decide before code exists (D-27, readback).
4. Boundary-rule findings are routed as implementation defects (D-29).
5. Repeated lineages repeat repairs until the review budget runs out (D-29).
6. Planner repair designs for plain defects cost an expensive run per round (D-29).
7. No usage telemetry (D-28).
