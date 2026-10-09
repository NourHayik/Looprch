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
    assert.match(first, /This is the first review: report every finding in this one pass/);
    assert.doesNotMatch(first, /Repair since your last review/);
    assert.doesNotMatch(first, /This is the final review/);
    const second = review(2, 3, true);
    assert.match(second, /Time budget: up to 90m/);
    assert.match(second, /Repair since your last review: `git diff --stat tree2 tree3`/);
    assert.match(second, /report what still holds and anything new/);
    assert.match(second, /The code changed since your last run: inspect the current files/);
    assert.match(review(3), /This is the final review\. Request changes only for high or critical defects/);
    assert.match(review(1, 1), /This is the final review/);
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
    assert.match(roleText("implementer", "repair"), /same defect wherever else it occurs/);
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
