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

  test("user-rules.md is listed when present", () => {
    const root = tmp();
    mkdirSync(join(root, ".looprch"), { recursive: true });
    writeFileSync(join(root, ".looprch/user-rules.md"), "rules");
    assert.match(assembleBrief(input({ root })), /\.looprch\/user-rules\.md/);
    assert.doesNotMatch(assembleBrief(input()), /user-rules/);
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
    assert.match(b, /never write or edit tests/);
  });

  test("read-only roles get the read-only rule", () => {
    assert.match(assembleBrief(input({ role: "reviewer", task: "review" })), /You are read-only/);
  });

  test("review rounds: comprehensive first pass, safety-net re-review, final review", () => {
    const timeouts = ["60m", "90m", "2h"];
    const review = (n: number, of = 3, resume = false) =>
      assembleBrief(input({ role: "reviewer", task: "review", resume, reviewRound: { n, of, tree: "tree3", prevTree: n > 1 ? "tree2" : null, timeout: timeouts[n - 1] ?? "2h" } }));
    const first = review(1);
    assert.match(first, /Review round 1 of 3\. Time budget: up to 60m\./);
    assert.match(first, /`git diff --stat abc123 tree3`/);
    assert.match(first, /follow the first-review procedure and checklist and report every finding in this one pass/);
    assert.doesNotMatch(first, /Repair since your last review/);
    assert.doesNotMatch(first, /This is the final review/);
    const second = review(2, 3, true);
    assert.match(second, /Time budget: up to 90m/);
    assert.match(second, /Repair since your last review: `git diff --stat tree2 tree3`/);
    assert.match(second, /report anything the earlier review missed/);
    assert.doesNotMatch(second, /unless they are high or critical/);
    assert.match(second, /The code changed since your last run: inspect the current files/);
    assert.doesNotMatch(second, /This is the final review/);
    const last = review(3);
    assert.match(last, /Review round 3 of 3\./);
    assert.match(last, /This is the final review\. Still put every remaining issue in `findings`/);
    assert.match(review(1, 1), /This is the final review/);
    const role = roleText("reviewer", "review");
    for (const s of [/## Coverage/, /Walk every plan step and every requirement id/, /Security: trust boundaries/, /"origin": "missed"/, /`owner`/]) assert.match(role, s);
    assert.match(roleText("reviewer", "adhoc_review"), /Checklist:/);
    assert.match(roleText("implementer", "repair"), /same defect wherever else it occurs/);
    assert.match(roleText("implementer", "repair"), /report `resolutions`/);
    assert.match(roleText("implementer", "repair"), /Fix the rule it\s+states, not only the example/);
    assert.match(roleText("implementer", "repair"), /Report `fixed` only\s+when the whole rule holds/);
    assert.match(role, /Describe the broken rule, not only the example/);
    assert.match(roleText("tester", "testing"), /try at least one variant the example did not cover/);
  });

  test("output contract shows the object shapes reviewers and implementers must return", () => {
    const r = assembleBrief(input({ role: "reviewer", task: "review" }));
    assert.match(r, /"manual_gate_reports": \[\{"gate_id":"…","path":"\.looprch\/reports\/…"\}\]/);
    assert.match(r, /"owner":"implementer\|tester"/);
    assert.match(assembleBrief(input({ role: "implementer", task: "repair" })), /"resolutions": \[\{"id":"R-1","status":"fixed\|not_fixed"/);
  });

  test("delta findings show owner, origin and the fix condition", () => {
    const b = assembleBrief(
      input({ role: "tester", task: "testing", delta: { kind: "repair", text: "Verify:", findings: [{ id: "R-7", severity: "medium", owner: "tester", origin: "unfixed", summary: "missing tests", fix: "two-connection test" }] } }),
    );
    assert.match(b, /- R-7 \[medium, owner tester, unfixed\]: missing tests/);
    assert.match(b, /  Fix: two-connection test/);
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
