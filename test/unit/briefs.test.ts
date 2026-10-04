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
