import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "../helpers/tmp.js";
import { assembleBrief, roleText, type BriefInput } from "../../src/core/briefs.js";

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    root: tmp(),
    runId: "P-001-planner-1",
    role: "planner",
    task: "planning",
    stage: "planning",
    phase: "P-001",
    phaseTitle: "Identifier foundation",
    phaseBase: "abc123",
    packet: { path: ".looprch/packets/P-001/planner.md", bytes: 4096 },
    phaseSource: "phases/en/P-001.md",
    inputs: [],
    delta: null,
    userNote: null,
    resume: false,
    gateIds: ["GATE-1"],
    ...over,
  };
}

describe("briefs", () => {
  test("machine-readable header and packet path, never inlined", () => {
    const b = assembleBrief(input());
    assert.match(b, /<!-- looprch: run_id=P-001-planner-1 role=planner phase=P-001 stage=planning task=planning phase_base=abc123 -->/);
    assert.match(b, /`\.looprch\/packets\/P-001\/planner\.md` — exact-source SEV3 packet \(4096 bytes\)/);
    assert.doesNotMatch(b, /## SOURCE/);
    assert.match(b, /```looprch-result/);
    assert.match(b, /`plan_ready`, `needs_expansion`/);
  });

  test("user-rules.md is listed when present, and its absence is stated (a spec may require reading it)", () => {
    const root = tmp();
    mkdirSync(join(root, ".looprch"), { recursive: true });
    writeFileSync(join(root, ".looprch/user-rules.md"), "rules");
    assert.match(assembleBrief(input({ root })), /`\.looprch\/user-rules\.md` — project rules every role follows/);
    assert.match(assembleBrief(input()), /`\.looprch\/user-rules\.md` — does not exist: this project has no additional user rules/);
  });

  test("closed handover pointers and delta findings appear", () => {
    const b = assembleBrief(
      input({
        role: "implementer",
        task: "repair",
        inputs: [{ path: ".looprch/phases/P-000/handover.md", why: "CLOSED handover" }],
        delta: { kind: "repair", text: "Fix these:", findings: [{ id: "R-1", severity: "high", summary: "bad", files: ["a.py"] }] },
        userNote: "be careful",
      }),
    );
    assert.match(b, /P-000\/handover\.md/);
    assert.match(b, /R-1 \[high\]: bad — a\.py/);
    assert.match(b, /User note: be careful/);
    assert.match(b, /Change the files your work needs/);
  });

  test("phase roles have no file restrictions; only advisory side runs are read-only", () => {
    assert.match(assembleBrief(input({ role: "reviewer", task: "review" })), /You review; you do not need to change files/);
    assert.doesNotMatch(assembleBrief(input({ role: "reviewer", task: "review" })), /read-only|git status before and after/);
    assert.match(assembleBrief(input({ role: "worker", task: "worker", packet: null, question: "q" })), /advisory run: do not change any file/);
    assert.match(assembleBrief(input({ role: "reviewer", task: "adhoc_review", readOnly: true })), /advisory run/);
  });

  test("Planner and Plan Debater briefs state the Implementer and its context budget", () => {
    assert.match(assembleBrief(input({ implementer: { agent: "opencode", model: "deepseek/deepseek-v4.1-flash", context_kb: 4000 } })), /The Implementer of this phase is opencode\/deepseek\/deepseek-v4\.1-flash, with a context budget of 4000 KB \(about 1000K tokens\)/);
    assert.match(assembleBrief(input({ role: "plan_debater", task: "debate", implementer: { agent: "codex", model: "m", context_kb: null } })), /an unknown context budget: assume about 200K tokens/);
    assert.match(assembleBrief(input({ implementer: null })), /The Implementer is not configured/);
  });

  test("review rounds: first pass, re-review, final review", () => {
    const timeouts = ["60m", "90m", "2h"];
    const review = (n: number, of = 3, resume = false) =>
      assembleBrief(input({ role: "reviewer", task: "review", resume, reviewRound: { n, of, tree: "tree3", prevTree: n > 1 ? "tree2" : null, timeout: timeouts[n - 1] ?? "2h" } }));
    const first = review(1);
    assert.match(first, /Review round 1 of 3\. Time budget: up to 60m\./);
    assert.match(first, /`git diff --stat abc123 tree3`/);
    assert.match(first, /This is the first review: report every finding in this one pass\./);
    assert.doesNotMatch(first, /Repair since your last review/);
    assert.doesNotMatch(first, /This is the final review/);
    const second = review(2, 3, true);
    assert.match(second, /Time budget: up to 90m/);
    assert.match(second, /Repair since your last review: `git diff --stat tree2 tree3`/);
    assert.match(second, /report what still holds and anything new/);
    assert.match(second, /The code changed since your last run: inspect the current files/);
    assert.match(review(3), /This is the final scheduled review\. Apply the same severity and approval standard/);
    assert.match(review(1, 1), /This is the final scheduled review/);
  });

  test("role prompts describe the simple workflow", () => {
    const planner = roleText("planner", "planning");
    for (const s of [/\*\*Concept and architecture\*\*/, /\*\*Plan phases\*\*/, /\*\*Done when\*\*/, /One session for the whole phase is the normal case/, /Never write whole files/, /closed rule/]) assert.match(planner, s);
    assert.doesNotMatch(planner, /blueprint|obligation|work package/i);
    assert.match(roleText("planner", "synthesis"), /`accept`: change the plan so the problem cannot happen/);
    assert.match(roleText("planner", "context_answer"), /appended to\s+plan\.md as an addendum/);
    assert.match(roleText("plan_debater", "debate"), /Sessions that do not fit the Implementer/);
    assert.match(roleText("plan_debater", "rebuttal"), /### Task: rebuttal/);
    const impl = roleText("implementer", "implementation");
    assert.match(impl, /Start right away/);
    assert.match(impl, /Never ask just to confirm/);
    assert.match(impl, /`todos_done`/);
    assert.doesNotMatch(impl, /readback|deviation|blueprint/i);
    assert.match(roleText("implementer", "repair"), /at their root\s+cause, for every instance/);
    assert.match(roleText("tester", "testing"), /cover at least one input class the Implementer did not mention/);
    assert.match(roleText("tester", "testing"), /Mock only real external boundaries, never the unit under test/);
    assert.match(roleText("reviewer", "review"), /Read every changed file/);
    assert.match(roleText("reviewer", "adhoc_review"), /### Task: adhoc_review/);
  });

  test("output contract shows the object shapes each role returns", () => {
    const r = assembleBrief(input({ role: "reviewer", task: "review" }));
    assert.match(r, /"manual_gate_reports": \[\{"gate_id":"…","path":"\.looprch\/reports\/…"\}\]/);
    assert.match(r, /"owner":"implementer\|tester"/);
    assert.doesNotMatch(r, /contract_review|files_reviewed|"cause"|"repair"/);
    assert.match(assembleBrief(input({ role: "implementer", task: "implementation" })), /"todos_done": \["T-1"\]/);
    assert.match(assembleBrief(input({ role: "implementer", task: "implementation" })), /only for a question that blocks the work/);
    assert.match(assembleBrief(input({ role: "implementer", task: "repair" })), /"resolutions": \[\{"id":"R-1","status":"fixed\|not_fixed"/);
    assert.match(assembleBrief(input({ role: "implementer", task: "handover" })), /Looprch adds the file lists from git/);
    assert.match(assembleBrief(input({ role: "plan_debater", task: "rebuttal" })), /"verdicts": \[\{"id":"D-1","verdict":"resolved\|conceded\|upheld"/);
    assert.match(assembleBrief(input({ role: "plan_debater", task: "debate" })), /"suggestion":"the change that closes it"/);
    assert.match(assembleBrief(input({ role: "implementer", task: "implementation" })), /plan\.md is your instruction/);
    assert.match(assembleBrief(input({ role: "planner", task: "planning" })), /"plan": \{"todos": \[/);
    assert.match(assembleBrief(input({ role: "planner", task: "planning" })), /"sessions": \[\["T-1","T-2","T-3"\]\]/);
    assert.match(assembleBrief(input({ role: "planner", task: "synthesis" })), /"debate_dispositions": \[\{"id":"D-1","decision":"accept\|reject"/);
    assert.match(assembleBrief(input({ role: "planner", task: "context_answer" })), /"new_todos"/);
  });

  test("delta findings show severity, owner and the fix condition", () => {
    const b = assembleBrief(input({ role: "tester", task: "testing", delta: { kind: "repair", text: "Verify:", findings: [{ id: "R-7", severity: "medium", owner: "tester", summary: "missing tests", fix: "two-connection test" }] } }));
    assert.match(b, /- R-7 \[medium, owner tester\]: missing tests\n  Fix: two-connection test/);
    const ref = assembleBrief(input({ role: "implementer", task: "repair", delta: { kind: "repair", text: "Fix:", findings: [{ id: "R-1", severity: "high", owner: "implementer", plan_ref: "Decision 5", summary: "log mailer offered" }] } }));
    assert.match(ref, /- R-1 \[high, owner implementer, plan Decision 5\]: log mailer offered/);
    const scoped = assembleBrief(input({ role: "implementer", task: "repair", delta: { kind: "repair", text: "Fix:", findings: [{ id: "R-5", severity: "high", summary: "English copy on Arabic screens", fix: "every visible string is translated", scope: "rg -n \"'[A-Z][a-z]+\" resources/js; every page and component" }] } }));
    assert.match(scoped, /  Fix: every visible string is translated\n  Scope: rg -n "'\[A-Z\]\[a-z\]\+" resources\/js; every page and component/);
  });

  test("first review searches for the whole class; a re-review reruns the scope before closing", () => {
    const review = (n: number) => assembleBrief(input({ role: "reviewer", task: "review", reviewRound: { n, of: 3, tree: "t", prevTree: n > 1 ? "p" : null, timeout: "60m" } }));
    assert.match(review(1), /For each one, search the whole phase for every instance of the rule it breaks, and record the search in its scope/);
    assert.match(review(2), /rerun each one's Scope; close it only when no instance remains and its proof holds/);
  });

  test("all phase roles see the available verification; the Reviewer sees exclusions", () => {
    const verification = { gates: [{ id: "GATE-core", kind: "test", negative: false }, { id: "GATE-neg", kind: "test", negative: true }, { id: "GATE-ui", kind: "manual", negative: false }], e2e: false };
    for (const [role, task] of [["planner", "planning"], ["plan_debater", "debate"], ["implementer", "implementation"], ["tester", "testing"], ["reviewer", "review"]] as const) {
      const b = assembleBrief(input({ role, task, verification }));
      assert.match(b, /Verification available: declared gates GATE-core \(test\), GATE-neg \(test, negative\); e2e gate off \(nothing runs a browser[^)]*\); manual gates GATE-ui\./, role);
    }
    const excluded = assembleBrief(input({ role: "reviewer", task: "review", excludedTests: [{ id: "browser focus return", reason: "no browser runner", limitation: "keyboard behavior unverified" }] }));
    assert.match(excluded, /Tests excluded from this phase \(not pass evidence\):/);
    assert.match(excluded, /browser focus return: no browser runner Verification limitation: keyboard behavior unverified/);
    assert.match(assembleBrief(input({ role: "reviewer", task: "review", verification: { gates: [], e2e: true } })), /declared gates none; e2e gate on \(Looprch runs the e2e gate in a real browser[^)]*\); manual gates none\./);
  });

  test("a repair design brief asks the Planner for the rule, not an answer to a question", () => {
    const b = assembleBrief(input({ task: "context_answer", delta: { kind: "repair_design", text: "These review findings came back after a repair.", findings: [{ id: "R-5", severity: "high", summary: "English copy on Arabic screens" }] } }));
    assert.match(b, /Write the repair design for the review findings in the Delta: they came back after a repair/);
    assert.doesNotMatch(b, /Answer the Implementer's question/);
    assert.match(roleText("planner", "context_answer"), /When the Delta is a \*\*repair design\*\*/);
  });

  test("role prompts carry the convergence rules", () => {
    const planner = roleText("planner", "planning");
    assert.match(planner, /Every\s+component the phase creates, changes, adopts or depends on gets an explicit decision/);
    assert.match(planner, /existing code, code a starter kit, generator or template brings in/);
    assert.match(planner, /\*\*keep\*\*[\s\S]*\*\*adapt\*\*[\s\S]*\*\*remove\*\*/);
    assert.match(planner, /Decide every important choice in the plan/);
    assert.match(planner, /The SEV3 sources are the source of truth/);
    assert.match(planner, /never ask the user and never leave it to the Implementer/);
    assert.match(planner, /never weaken, drop or reinterpret a\s+requirement or constraint/);
    assert.match(planner, /Never promise browser or\s+manual checks that no gate runs/);
    assert.match(roleText("planner", "context_answer"), /never pass the decision back to the Implementer or the user/);
    const debater = roleText("plan_debater", "debate");
    assert.match(debater, /A component left undecided: existing code/);
    assert.match(debater, /A check no gate can run/);
    assert.match(debater, /A decision passed on or made against the sources/);
    const reviewer = roleText("reviewer", "review");
    assert.match(reviewer, /Plan conformance first/);
    assert.match(reviewer, /`plan_ref` is a todo id/);
    assert.match(reviewer, /do not file a finding for missing browser or\s+manual evidence/);
    assert.match(reviewer, /\*\*Every finding is a class of defects, not an example\.\*\*/);
    assert.match(reviewer, /Close a finding only when its whole class is fixed: rerun its `scope` search/);
    const repair = roleText("implementer", "repair");
    assert.match(repair, /Find every instance first: run the Scope search/);
    assert.match(repair, /Fix the shared cause at one place/);
    assert.match(roleText("implementer", "implementation"), /is not a small gap: ask the Planner/);
    const tester = roleText("tester", "testing");
    assert.match(tester, /Never record a\s+stand-in/);
    assert.match(tester, /prove every finding in the Delta that an available gate can exercise/);
    assert.match(tester, /`fixed` means\s+verified, with the testcase names in `tests`/);
    assert.match(assembleBrief(input({ role: "reviewer", task: "review" })), /"plan_ref":"T-4 \| Decision 5[^"]*","scope":"where the rule applies/);
    assert.match(assembleBrief(input({ role: "tester", task: "testing" })), /"resolutions": \[\{"id":"R-12","status":"fixed\|not_fixed","note":"[^"]*","tests":\[/);
    assert.match(assembleBrief(input({ role: "implementer", task: "repair" })), /"resolutions": \[\{"id":"R-1","status":"fixed\|not_fixed","note":"the instances you fixed and the search that found them","tests":\[/);
  });

  test("role text picks the task section", () => {
    const t = roleText("planner", "synthesis");
    assert.match(t, /### Task: synthesis/);
    assert.doesNotMatch(t, /### Task: planning/);
  });

  test("worker brief has no packet and carries the question", () => {
    const b = assembleBrief(input({ role: "worker", task: "worker", packet: null, question: "Where is validate_id?" }));
    assert.match(b, /Question: Where is validate_id\?/);
    assert.match(b, /phases\/en\/P-001\.md/);
  });
});
