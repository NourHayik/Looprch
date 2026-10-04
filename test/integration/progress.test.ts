import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drive, readJson, setupProject } from "../helpers/lead.js";

const tag = (line: string) => /^\[([A-Z ]+)\]/.exec(line)?.[1] ?? "";

/** Asserts that `expected` tags appear in this order (other lines may sit in between). */
function assertInOrder(progress: string[], expected: string[]) {
  let at = 0;
  for (const t of expected) {
    const i = progress.findIndex((l, j) => j >= at && tag(l) === t);
    assert.ok(i >= 0, `missing [${t}] after line ${at}:\n${progress.join("\n")}`);
    at = i + 1;
  }
}

describe("Lead progress lines (integration)", () => {
  test("one phase reports every workflow step once, including a debate with findings", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", decision: "findings" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assertInOrder(r.progress, [
      "PHASE START",
      "PREFLIGHT COMPLETE",
      "PLANNING START",
      "TASK START",
      "PLANNING COMPLETE",
      "DEBATE START",
      "TASK START",
      "DEBATE COMPLETE",
      "PLAN UPDATE START",
      "PLAN UPDATED",
      "IMPLEMENTATION START",
      "TASK START",
      "IMPLEMENTATION COMPLETE",
      "TESTING START",
      "CHECKPOINT",
      "TESTING COMPLETE",
      "GATES START",
      "GATES COMPLETE",
      "REVIEW START",
      "REVIEW COMPLETE",
      "HANDOVER START",
      "HANDOVER COMPLETE",
      "CLOSING START",
      "PHASE COMPLETE",
    ]);
    const debate = r.progress.find((l) => tag(l) === "DEBATE COMPLETE")!;
    assert.match(debate, /Result: Changes recommended \(1 finding: 1 medium\)/);
    assert.match(debate, /Summary: D-1 \(medium\): Clarify error handling\./);
    assert.match(r.progress.find((l) => tag(l) === "PHASE COMPLETE")!, /P-001 closed and merged \(tag looprch\/P-001\)/);
    assert.equal(r.progress.filter((l) => tag(l) === "PHASE START").length, 1);
    const starts = r.progress.filter((l) => tag(l) === "TASK START").map((l) => l.split(":")[0]);
    assert.deepEqual(starts, [...new Set(starts)], "a run start was reported twice");
    const journal = readFileSync(join(p.root, ".looprch/events.jsonl"), "utf8").trim().split("\n");
    assert.equal(readJson(join(p.root, ".looprch/runs/progress.json")).reported_seq, JSON.parse(journal.at(-1)!).seq);
    p.s.cleanup();
  });

  test("a debate without findings says the original plan was accepted", () => {
    const p = setupProject();
    const r = drive({ root: p.root, env: p.env, onAction: (a) => (a.action === "run_role" && a.role === "implementer" ? "stop" : undefined) });
    const debate = r.progress.find((l) => tag(l) === "DEBATE COMPLETE")!;
    assert.equal(debate, "[DEBATE COMPLETE]\nResult: No changes recommended. Original plan accepted.");
    assert.ok(!r.progress.some((l) => tag(l) === "PLAN UPDATED"));
    p.s.cleanup();
  });

  test("failures report the issue, the retry and the fallback", () => {
    const p = setupProject();
    p.setScenario([{ agent: "opencode", role: "implementer", status: "failed", stderr: "boom" }]);
    const r = drive({ root: p.root, env: p.env, onAction: (a) => (a.action === "run_role" && a.role === "tester" ? "stop" : undefined) });
    const issues = r.progress.filter((l) => tag(l) === "ISSUE");
    assert.equal(issues.length, 2, r.progress.join("\n"));
    assert.match(issues[0]!, /^\[ISSUE\]\nTask P-001-implementer-1 \(Implementer on opencode\) failed\.\nReason: failed/);
    assert.match(issues[0]!, /Action: Retry with the same agent\./);
    assert.match(issues[1]!, /Action: Switching the Implementer to codex\/codex-impl\./);
    assert.ok(r.progress.some((l) => /^\[RETRY\] P-001-implementer-2: Implementer \(implementation\) on opencode\/oc\/impl · delegate · attempt 2$/.test(l)), r.progress.join("\n"));
    assert.ok(r.progress.includes("[FALLBACK] Implementer: opencode/oc/impl replaced by codex/codex-impl (run failed fallback)."), r.progress.join("\n"));
    assert.ok(r.progress.some((l) => /^\[TASK START\] P-001-implementer-3: Implementer \(implementation\) on codex\/codex-impl · delegate · fallback: earlier runs failed$/.test(l)), r.progress.join("\n"));
    p.s.cleanup();
  });
});
