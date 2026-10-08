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
  test("changes_requested needs findings with files", () => {
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [] }).ok, false);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "x" }] }).ok, false);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "x", files: ["a.py"] }] }).ok, false, "cause is required");
    const repair = { files: [{ path: "a.py", action: "modify", content: "f rejects x" }], steps: ["make f reject x"], done_when: ["python3 -m unittest exits 0"] };
    const noRepair = validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "x", files: ["a.py"], cause: "implementation", checks: ["rejects x"] }] });
    assert.match(!noRepair.ok ? noRepair.errors.join(";") : "", /R-1: an implementation finding carries "repair"/);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "x", files: ["a.py"], cause: "implementation", checks: ["rejects x"], repair }] }).ok, true);
    const badRepair = validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "x", files: ["a.py"], cause: "implementation", checks: ["rejects x"], repair: { ...repair, steps: [] } }] });
    assert.match(!badRepair.ok ? badRepair.errors.join(";") : "", /steps must be a non-empty list/);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "x", files: ["a.py"], cause: "plan", checks: ["rejects x"] }] }).ok, true, "a plan-cause finding goes to the Planner and needs no repair");
  });
  test("changes_requested with only low findings must approve instead", () => {
    const low = { id: "R-1", severity: "low", summary: "nit", files: ["a.py"], cause: "implementation" };
    const r = validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [low] });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.errors.join(";") : "", /use approve/);
    const repair = { files: [{ path: "a.py", action: "modify", content: "c" }], steps: ["s"], done_when: ["d"] };
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [low, { ...low, id: "R-2", severity: "medium", repair }] }).ok, true);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "approve", findings: [low] }).ok, true);
  });
  test("review finding fields and implementer resolutions are validated", () => {
    const f = { id: "R-1", severity: "high", summary: "x", files: ["a.py"], fix: "y", owner: "tester", origin: "missed", cause: "test", obligations: ["O-1"], related: "R-0", checks: ["rejects x", "rejects y"] };
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [f] }).ok, true);
    const noChecks = validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ ...f, checks: [] }] });
    assert.match(!noChecks.ok ? noChecks.errors.join(";") : "", /R-1 is high: list the acceptance checks/);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ ...f, severity: "medium", checks: undefined }] }).ok, true, "checks are optional below high");
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ ...f, owner: "planner" }] }).ok, false);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ ...f, origin: "new" }] }).ok, false);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ ...f, cause: "luck" }] }).ok, false);
    const testOwned = validateResult("reviewer", { role: "reviewer", decision: "changes_requested", findings: [{ ...f, owner: "implementer" }] });
    assert.match(!testOwned.ok ? testOwned.errors.join(";") : "", /cause test has owner tester/);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "approve", contract_review: [{ id: "O-1", status: "maybe" }] }).ok, false);
    assert.equal(validateResult("reviewer", { role: "reviewer", decision: "approve", prior: [{ id: "R-1", status: "fixed" }], contract_review: [{ id: "O-1", status: "met" }] }).ok, true);
    const strings = validateResult("reviewer", { role: "reviewer", decision: "approve", manual_gate_reports: [".looprch/reports/t.json"] });
    assert.match(!strings.ok ? strings.errors.join(";") : "", /needs gate_id and path/);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", resolutions: [{ id: "R-1", status: "fixed", note: "done", files: ["a.py"] }] }).ok, true);
    const noFiles = validateResult("implementer", { role: "implementer", decision: "implemented", resolutions: [{ id: "R-1", status: "fixed", note: "done" }] });
    assert.match(!noFiles.ok ? noFiles.errors.join(";") : "", /a fixed resolution lists the files/);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", resolutions: [{ id: "R-1", status: "needs_design" }, { id: "R-2", status: "not_fixed" }] }).ok, true);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", resolutions: [{ id: "R-1", status: "partly" }] }).ok, false);
  });
  test("plan results need a contract; synthesis dispositions and amendments are shaped", () => {
    const test1 = { id: "T-1", obligation: "O-1", kind: "negative", given: "an empty id", when: "f runs", then: "it raises ValueError", file: "tests/test_a.py" };
    const wp = { id: "WP-1", title: "t", obligations: ["O-1"], precision: "spec", files: [{ path: "a.py", action: "create", content: "f() -> int" }], steps: ["write f"], done_when: ["python3 -c 'import a'"], tests: [test1] };
    const contract = { obligations: [{ id: "O-1", requirements: ["R-ID"], kind: "behavior", statement: "s", enforcement: "e", verify: "v", gates: [] }], deferrals: [], decisions: [], interfaces: [], work_packages: [wp] };
    const noWp = validateResult("planner", { role: "planner", decision: "plan_ready", contract: { ...contract, work_packages: undefined } });
    assert.match(!noWp.ok ? noWp.errors.join(";") : "", /contract\.work_packages must be a list/);
    const errs = (c: unknown) => {
      const v = validateResult("planner", { role: "planner", decision: "plan_ready", contract: c });
      return v.ok ? "" : v.errors.join(";");
    };
    assert.match(errs({ ...contract, decisions: undefined }), /contract\.decisions must be a list/);
    assert.match(errs({ ...contract, interfaces: [{ id: "IF-1", file: "a.py", symbol: "f" }] }), /IF-1: signature is required/);
    assert.match(errs({ ...contract, work_packages: [{ ...wp, precision: "rough" }] }), /precision must be "spec" or "full_content"/);
    assert.match(errs({ ...contract, work_packages: [{ ...wp, tests: undefined }] }), /tests must list the tests the Tester writes/);
    assert.match(errs({ ...contract, work_packages: [{ ...wp, tests: [{ ...test1, kind: "smoke" }] }] }), /T-1: kind must be one of positive, negative, boundary, adversarial/);
    assert.match(errs({ ...contract, obligations: [{ ...contract.obligations[0], kind: "boundary" }] }), /O-1: kind boundary needs "rule"/);
    assert.equal(errs({ ...contract, obligations: [{ ...contract.obligations[0], kind: "boundary", rule: "only ids matching ^[a-z]{3}$ are accepted" }] }), "");
    const bigWp = validateResult("planner", { role: "planner", decision: "plan_ready", contract: { ...contract, work_packages: [{ ...wp, steps: Array.from({ length: 26 }, () => "s") }] } });
    assert.match(!bigWp.ok ? bigWp.errors.join(";") : "", /WP-1 has 26 steps \(max 25\): split it/);
    assert.equal(validateResult("planner", { role: "planner", decision: "plan_ready", contract: { ...contract, work_packages: [{ ...wp, files: [{ path: "old.py", action: "delete" }] }] } }).ok, true, "a deleted file needs no content");
    const vague = validateResult("planner", { role: "planner", decision: "plan_ready", contract: { ...contract, work_packages: [{ ...wp, files: [{ path: "a.py", action: "create", content: "" }] }] } });
    assert.match(!vague.ok ? vague.errors.join(";") : "", /content must say what the file contains/);
    const rp = { id: "RP-1", title: "t", findings: ["R-1", "R-2", "R-3", "R-4", "R-5", "R-6"], files: wp.files, steps: ["s"], done_when: ["d"] };
    const bigRp = validateResult("planner", { role: "planner", decision: "context_answer", repair_packages: [rp] });
    assert.match(!bigRp.ok ? bigRp.errors.join(";") : "", /RP-1 repairs 6 findings \(max 5\)/);
    assert.match((validateResult("planner", { role: "planner", decision: "plan_ready" }) as { errors: string[] }).errors.join(";"), /contract is required/);
    assert.equal(validateResult("planner", { role: "planner", decision: "plan_ready", contract }).ok, true);
    const badKind = validateResult("planner", { role: "planner", decision: "plan_final", contract: { ...contract, obligations: [{ ...contract.obligations[0], kind: "wish" }] } });
    assert.match(!badKind.ok ? badKind.errors.join(";") : "", /kind must be one of/);
    const noVerify = validateResult("planner", { role: "planner", decision: "plan_final", contract: { ...contract, obligations: [{ ...contract.obligations[0], verify: "" }] } });
    assert.match(!noVerify.ok ? noVerify.errors.join(";") : "", /verify is required/);
    const deferral = validateResult("planner", { role: "planner", decision: "plan_final", contract: { ...contract, deferrals: [{ id: "X-1", requirements: [], what: "w", to_phase: "P-002" }] } });
    assert.match(!deferral.ok ? deferral.errors.join(";") : "", /interim is required/);
    assert.equal(validateResult("planner", { role: "planner", decision: "plan_final", contract, debate_dispositions: [{ id: "D-1", decision: "maybe", reason: "r" }] }).ok, false);
    assert.equal(validateResult("planner", { role: "planner", decision: "plan_final", contract, debate_dispositions: [{ id: "D-1", decision: "partial", reason: "r", refs: ["WP-1"] }] }).ok, true);
    assert.equal(validateResult("planner", { role: "planner", decision: "context_answer" }).ok, true);
    assert.equal(validateResult("planner", { role: "planner", decision: "context_answer", contract_amendment: { obligations: [{ id: "O-2" }] } }).ok, false);
    assert.equal(validateResult("planner", { role: "planner", decision: "context_answer", contract_amendment: { retire: ["O-1"] } }).ok, true);
  });
  test("tester verifications are shaped: verified needs testcases", () => {
    assert.equal(validateResult("tester", { role: "tester", decision: "pass", verifications: [{ id: "O-1", status: "verified", tests: ["t"], variants: [] }] }).ok, true);
    assert.equal(validateResult("tester", { role: "tester", decision: "pass", verifications: [{ id: "O-1", status: "verified", tests: [], variants: [] }] }).ok, false);
    assert.equal(validateResult("tester", { role: "tester", decision: "pass", verifications: [{ id: "O-1", status: "inspected", tests: [], variants: [] }] }).ok, true);
    assert.equal(validateResult("tester", { role: "tester", decision: "pass", verifications: [{ id: "O-1", status: "ok", tests: [], variants: [] }] }).ok, false);
    assert.equal(validateResult("tester", { role: "tester", decision: "pass", verifications: [{ id: "R-1", status: "verified", tests: ["t"], variants: [], checks: [{ n: 1, tests: ["t"] }] }] }).ok, true);
    assert.equal(validateResult("tester", { role: "tester", decision: "pass", verifications: [{ id: "R-1", status: "verified", tests: ["t"], variants: [], checks: [{ tests: ["t"] }] }] }).ok, false);
  });
  test("handover needs file lists", () => {
    assert.equal(validateResult("implementer", { role: "implementer", decision: "handover_ready" }).ok, false);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "handover_ready", modified_files: [], new_files: ["a"], deleted_files: [] }).ok, true);
  });
  test("needs_context needs a context request", () => assert.equal(validateResult("implementer", { role: "implementer", decision: "needs_context" }).ok, false));
  test("plan debater findings carry evidence, a failure scenario and a resolution; rebuttal verdicts are shaped", () => {
    const f = { id: "D-1", severity: "high", summary: "s", evidence: "packet §2", failure_scenario: "the executor guesses", proposed_resolution: "decide it" };
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "findings", findings: [f] }).ok, true);
    const bare = validateResult("plan_debater", { role: "plan_debater", decision: "findings", findings: [{ ...f, failure_scenario: undefined }] });
    assert.match(!bare.ok ? bare.errors.join(";") : "", /D-1: failure_scenario is required/);
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "agree", verdicts: [{ id: "D-1", verdict: "resolved" }] }).ok, true);
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "findings", verdicts: [{ id: "D-1", verdict: "upheld", note: "still open" }] }).ok, true, "an upheld verdict alone keeps the debate going");
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "findings", verdicts: [{ id: "D-1", verdict: "resolved" }] }).ok, false);
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "agree", verdicts: [{ id: "D-1", verdict: "maybe" }] }).ok, false);
    assert.equal(validateResult("plan_debater", { role: "plan_debater", decision: "no_findings", independent_risks: [{ risk: "r" }] }).ok, false);
  });
  test("readback lists packages; ready has no questions; deviations are shaped", () => {
    const pkg = { id: "WP-1", questions: [], decisions_needed: [], would_create: [{ path: "a.py", symbols: ["f"] }] };
    assert.equal(validateResult("implementer", { role: "implementer", decision: "ready", packages: [pkg] }).ok, true);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "ready" }).ok, false);
    const asks = validateResult("implementer", { role: "implementer", decision: "ready", packages: [{ ...pkg, questions: ["which error?"] }] });
    assert.match(!asks.ok ? asks.errors.join(";") : "", /use decision questions/);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "questions", packages: [{ ...pkg, decisions_needed: ["the library"] }] }).ok, true);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", deviations: [{ file: "b.py", what: "import" }] }).ok, false);
    assert.equal(validateResult("implementer", { role: "implementer", decision: "implemented", work_packages: ["WP-1", "WP-2"], deviations: [{ file: "b.py", what: "import", why: "missing" }] }).ok, true);
  });
  test("expansion requests are validated", () => assert.equal(validateResult("planner", { role: "planner", decision: "needs_expansion", expansion_requests: [{ kind: "file", id: "x" }] }).ok, false));
  test("run_id mismatch", () => assert.equal(validateResult("worker", { role: "worker", decision: "answered", run_id: "a" }, "b").ok, false));
});
