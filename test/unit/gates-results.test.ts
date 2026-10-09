import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "../helpers/tmp.js";
import { parseUnittest } from "../../src/gates/unittest.js";
import { parseJunit } from "../../src/gates/junit.js";
import { runGate } from "../../src/gates/runner.js";
import { defaultConfig } from "../../src/core/config.js";
import { extractResultBlock, validateResult } from "../../src/core/results.js";
import type { Gate } from "../../src/sev3/manifest.js";

describe("unittest parser", () => {
  test("passing run", () => {
    const r = parseUnittest("...\n----------------------------------------------------------------------\nRan 3 tests in 0.001s\n\nOK\n", 0);
    assert.equal(r.ok, true);
    assert.equal(r.counts.tests, 3);
  });
  test("Ran 0 tests fails", () => assert.match(parseUnittest("Ran 0 tests in 0.000s\n\nOK\n", 0).reason!, /Ran 0/));
  test("FAILED fails with counts", () => {
    const r = parseUnittest("Ran 4 tests in 0.1s\n\nFAILED (failures=1, errors=1)\n", 1);
    assert.equal(r.ok, false);
    assert.equal(r.counts.failures, 1);
    assert.equal(r.counts.errors, 1);
  });
  test("all skipped fails", () => assert.match(parseUnittest("Ran 2 tests in 0s\n\nOK (skipped=2)\n", 0).reason!, /skipped/));
  test("some skipped passes", () => assert.equal(parseUnittest("Ran 3 tests in 0s\n\nOK (skipped=1)\n", 0).ok, true));
  test("OK text with a non-zero exit fails", () => assert.match(parseUnittest("Ran 3 tests in 0s\n\nOK\n", 1).reason!, /exit code/));
  test("no Ran line fails", () => assert.equal(parseUnittest("hello", 0).ok, false));
});

describe("junit parser", () => {
  const wrap = (cases: string, attrs = 'tests="2" failures="0" errors="0"') => `<?xml version="1.0"?><testsuites><testsuite name="s" ${attrs}>${cases}</testsuite></testsuites>`;
  test("clean report passes", () => assert.equal(parseJunit(wrap('<testcase name="a"/><testcase name="b"></testcase>')).ok, true));
  test("zero testcases fails", () => assert.match(parseJunit(wrap("")).reason!, /no testcases/));
  test("all skipped fails", () => assert.match(parseJunit(wrap('<testcase name="a"><skipped/></testcase>')).reason!, /skipped/));
  test("testcase failure fails", () => assert.equal(parseJunit(wrap('<testcase name="a"><failure message="x"/></testcase><testcase name="b"/>')).ok, false));
  test("testcase error fails", () => assert.equal(parseJunit(wrap('<testcase name="a"><error/></testcase>')).ok, false));
  test("suite declaring failures=1 with clean testcases fails (5.x bug F-02)", () => {
    const r = parseJunit(wrap('<testcase name="a"/><testcase name="b"/>', 'tests="2" failures="1" errors="0"'));
    assert.equal(r.ok, false);
    assert.match(r.reason!, /declare failures=1/);
  });
  test("not junit at all fails", () => assert.equal(parseJunit("<html/>").ok, false));
});

describe("gate runner", () => {
  const cfg = defaultConfig();
  const gate = (over: Partial<Gate>): Gate => ({ id: "G", kind: "test", command: ["true"], negative: false, requirements: ["R"], evidence: { format: "none" }, ...over });

  test("a test gate with format none never passes", () => {
    const d = tmp();
    const r = runGate(d, cfg, gate({ command: [process.execPath, "-e", ""] }), "P-1-g-1", d, "tree", null);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /machine evidence/);
  });

  test("a static gate with format none passes on exit 0", () => {
    const d = tmp();
    assert.equal(runGate(d, cfg, gate({ kind: "static", command: [process.execPath, "-e", ""] }), "g1", d, "t", null).ok, true);
  });

  test("every gate run records its provenance: runner, finish time, HEAD and output hashes", () => {
    const d = tmp();
    const r = runGate(d, cfg, gate({ kind: "static", command: [process.execPath, "-e", "console.log('hi')"] }), "g1", d, "t", null, "abc123");
    assert.equal(r.runner?.name, "looprch");
    assert.match(r.runner?.version ?? "", /^\d+\.\d+\.\d+/);
    assert.equal(r.head_commit, "abc123");
    assert.ok(Date.parse(r.finished_at!) >= Date.parse(r.started_at));
    assert.match(r.stdout_sha256!, /^[0-9a-f]{64}$/);
    assert.match(r.stderr_sha256!, /^[0-9a-f]{64}$/);
  });

  test("timeout", () => {
    const d = tmp();
    const r = runGate(d, cfg, gate({ kind: "static", command: [process.execPath, "-e", "setTimeout(()=>{},5000)"], timeout_seconds: 1 }), "g1", d, "t", null);
    assert.equal(r.ok, false);
    assert.equal(r.timed_out, true);
  });

  test("a missing binary is reported", () => {
    const d = tmp();
    assert.match(runGate(d, cfg, gate({ kind: "static", command: ["no-such-binary-xyz"] }), "g1", d, "t", null).reason!, /command not found/);
  });

  test("gates.env is passed to the gate process", () => {
    const d = tmp();
    const c = defaultConfig();
    c.gates.env = { COREBIT_SPEC_ROOT: "/spec" };
    const r = runGate(d, c, gate({ kind: "static", command: [process.execPath, "-e", "process.exit(process.env.COREBIT_SPEC_ROOT === '/spec' ? 0 : 3)"] }), "g1", d, "t", null);
    assert.equal(r.ok, true);
  });

  test("junit evidence must be fresh", () => {
    const d = tmp();
    mkdirSync(join(d, ".looprch/test-evidence"), { recursive: true });
    const f = join(d, ".looprch/test-evidence/x.xml");
    writeFileSync(f, '<testsuite failures="0" errors="0"><testcase name="a"/></testsuite>');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(f, old, old);
    const r = runGate(d, cfg, gate({ evidence: { format: "junit", path: ".looprch/test-evidence/x.xml" }, command: [process.execPath, "-e", ""] }), "g1", d, "t", null);
    assert.match(r.reason!, /stale/);
  });

  test("manual gate needs an inspection report", () => {
    const d = tmp();
    const g = gate({ kind: "manual", command: [process.execPath, "-e", ""] });
    assert.match(runGate(d, cfg, g, "g1", d, "t", null).reason!, /inspection report/);
    mkdirSync(join(d, ".looprch/reports"), { recursive: true });
    writeFileSync(join(d, ".looprch/reports/r.md"), "inspected");
    assert.equal(runGate(d, cfg, g, "g2", d, "t", ".looprch/reports/r.md").ok, true);
  });
});

describe("result blocks", () => {
  const msg = (json: string) => `# Report\n\nbody\n\n\`\`\`looprch-result\n${json}\n\`\`\`\n`;
  const errs = (r: ReturnType<typeof validateResult>) => (r.ok ? "" : r.errors.join(";"));
  test("valid reviewer block; artifact is the markdown above", () => {
    const ex = extractResultBlock(msg('{"role":"reviewer","decision":"approve","findings":[]}'));
    assert.equal(ex.ok, true);
    assert.equal(ex.artifact, "# Report\n\nbody");
    assert.equal(validateResult("reviewer", ex.json).ok, true);
  });
  test("missing block", () => assert.equal(extractResultBlock("no block").ok, false));
  test("the last of several blocks wins", () => {
    const ex = extractResultBlock(`${msg('{"role":"tester","decision":"fail"}')}\n${msg('{"role":"tester","decision":"pass"}')}`);
    assert.equal((ex.json as any).decision, "pass");
  });
  test("invalid JSON", () => assert.match(extractResultBlock(msg("{nope")).error!, /not valid JSON/));
  test("wrong role", () => assert.equal(validateResult("tester", { role: "reviewer", decision: "pass" }).ok, false));
  test("review findings: id and summary; changes_requested needs at least one", () => {
    assert.match(errs(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [] })), /non-empty findings/);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", summary: "x" }] }).ok, true, "files, fix and owner are optional");
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", severity: "low", summary: "nit", files: ["a.py"], fix: "y", owner: "tester" }] }).ok, true, "a low-only review is not rejected");
    assert.match(errs(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", summary: "x", severity: "urgent" }] })), /severity must be one of/);
    assert.match(errs(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", summary: "x", owner: "planner" }] })), /owner must be one of/);
    assert.match(errs(validateResult("reviewer", { role: "reviewer", decision: "approve", manual_gate_reports: [".looprch/reports/t.json"] })), /needs gate_id and path/);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "approve", contract_review: [{ id: "O-1", status: "maybe" }], prior: "anything" }).ok, true, "fields of older protocols are ignored");
  });
  test("planner results need a plan with todos; sessions, requirements and deferrals are shaped", () => {
    const plan = { todos: [{ id: "T-1", title: "Add the ids module", section: "1. Data" }, { id: "T-2", title: "Wire the CLI" }], sessions: [["T-1", "T-2"]], requirements: { "R-ID": ["T-1"] }, deferrals: [{ id: "X-1", what: "auth", to_phase: "P-002" }] };
    assert.equal(validateResult("planner", { role: "planner", decision: "plan_ready", plan }).ok, true);
    assert.equal(validateResult("planner", { role: "planner", decision: "plan_ready", plan: { todos: plan.todos } }).ok, true, "sessions are optional");
    assert.match(errs(validateResult("planner", { role: "planner", decision: "plan_ready" })), /plan is required/);
    assert.match(errs(validateResult("planner", { role: "planner", decision: "plan_final", plan: { todos: [] } })), /plan\.todos must list the todos/);
    assert.match(errs(validateResult("planner", { role: "planner", decision: "plan_final", plan: { todos: [{ id: "T-1" }] } })), /each todo needs/);
    assert.match(errs(validateResult("planner", { role: "planner", decision: "plan_final", plan: { ...plan, sessions: ["T-1"] } })), /plan\.sessions must be a list of todo id lists/);
    assert.match(errs(validateResult("planner", { role: "planner", decision: "plan_final", plan: { ...plan, deferrals: [{ id: "X-1" }] } })), /each deferral needs/);
    assert.equal(validateResult("planner", { role: "planner", decision: "plan_final", plan, debate_dispositions: [{ id: "D-1", decision: "accept", note: "added T-3" }, { id: "D-2", decision: "reject" }] }).ok, true);
    assert.match(errs(validateResult("planner", { role: "planner", decision: "plan_final", plan, debate_dispositions: [{ id: "D-1", decision: "partial" }] })), /decision must be accept or reject/);
    assert.equal(validateResult("planner", { role: "planner", decision: "context_answer" }).ok, true);
    assert.equal(validateResult("planner", { role: "planner", decision: "context_answer", new_todos: [{ id: "T-9", title: "Add the index" }] }).ok, true);
    assert.match(errs(validateResult("planner", { role: "planner", decision: "context_answer", new_todos: [{ id: "T-9" }] })), /new_todos\[0\]/);
  });
  test("implementer: todos_done and optional resolutions; needs_context needs a question", () => {
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", todos_done: ["T-1"], files_changed: ["a.py"], notes: ["used argparse"] }).ok, true);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented" }).ok, true, "every field is optional");
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", resolutions: [{ id: "R-1", status: "fixed" }, { id: "R-2", status: "not_fixed", note: "later" }] }).ok, true);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", resolutions: [{ id: "R-1", status: "partly" }] }).ok, false);
    assert.match(errs(validateResult("implementer", { role: "implementer", decision: "needs_context" })), /needs_context requires context_request/);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "needs_context", context_request: { question: "Which store?" } }).ok, true);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "handover_ready" }).ok, true, "Looprch writes the handover file lists from git");
    assert.equal(validateResult("implementer", { role: "implementer", decision: "ready" }).ok, false, "the readback is gone");
  });
  test("tester and plan debater shapes", () => {
    assert.equal(validateResult("tester", { role: "tester", decision: "fail", failures: [{ id: "F-1", summary: "x" }] }).ok, true);
    assert.equal(validateResult("tester", { role: "tester", decision: "fail", failures: [{ id: "F-1" }] }).ok, false);
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "findings", findings: [{ id: "D-1", severity: "high", summary: "no store decided", section: "Decisions", suggestion: "pick SQLite" }] }).ok, true);
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "findings", findings: [{ id: "D-1", summary: "s" }] }).ok, true, "no evidence or failure scenario is required");
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "agree", verdicts: [{ id: "D-1", verdict: "resolved" }] }).ok, true);
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "agree", verdicts: [{ id: "D-1", verdict: "maybe" }] }).ok, false);
  });
  test("expansion requests are validated", () => {
    assert.equal(validateResult("planner", { role: "planner", decision: "needs_expansion", expansion_requests: [{ kind: "file", id: "x" }] }).ok, false);
    assert.match(errs(validateResult("planner", { role: "planner", decision: "needs_expansion" })), /needs "expansion_requests"/);
  });
  test("run_id mismatch", () => assert.equal(validateResult("worker", { role: "worker", decision: "answered", run_id: "a" }, "b").ok, false));
});
