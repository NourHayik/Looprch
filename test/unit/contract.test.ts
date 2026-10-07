import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amend, contractProblems, dispositionProblems, newContract, unresolvedByAmendment, type ContractBody } from "../../src/core/contract.js";
import { junitCases } from "../../src/gates/junit.js";
import { unittestCases } from "../../src/gates/unittest.js";
import { staleClaims, unbackedTests, type CaseIndex } from "../../src/gates/runner.js";
import type { Manifest, PhaseDef } from "../../src/sev3/manifest.js";

const gate = (id: string, kind: "test" | "static" = "test") => ({ id, kind, command: ["true"], negative: false, requirements: [], evidence: { format: "junit" as const, path: "x.xml" } });
const phase = (id: string, number: number, requirements: string[]): PhaseDef => ({ id, number, title: id, kind: "implementation", risk: "high", work_class: "m", en: `phases/en/${id}.md`, owns: [], requirements, gates: [gate(`${id}-BACKEND`), gate(`${id}-LINT`, "static")] });
const manifest: Manifest = {
  schema_version: "sev3/1",
  toolkit_version: "1.2.0",
  project: { id: "x", title: "x", canonical_language: "en" },
  documents: [{ id: "GLOBAL-SEC", kind: "global", en: "", ids: ["GLOBAL-SEC.01"] }],
  phases: [phase("P-001", 1, ["R-1.01", "R-1.02"]), phase("P-002", 2, ["R-2.01"])],
};
const ob = (id: string, requirements: string[], extra: object = {}) => ({ id, requirements, kind: "behavior" as const, statement: "s", enforcement: "e", verify: "v", gates: ["P-001-BACKEND"], ...extra });
const ctx = { phase: manifest.phases[0]!, manifest, incoming: [] };

describe("phase contract", () => {
  test("covers every mapped requirement, with known ids, real gates and later deferral targets", () => {
    const ok: ContractBody = { obligations: [ob("O-1", ["R-1.01", "GLOBAL-SEC.01"])], deferrals: [{ id: "X-1", requirements: ["R-1.02"], what: "auth", to_phase: "P-002", interim: "dependency_unavailable" }] };
    assert.deepEqual(contractProblems(ok, ctx), []);
    const bad: ContractBody = {
      obligations: [ob("O-1", ["R-1.01", "R-9.99"], { gates: ["NOPE"] }), ob("O-1", [])],
      deferrals: [{ id: "X-1", requirements: [], what: "w", to_phase: "P-001", interim: "i" }, { id: "X-2", requirements: [], what: "w", to_phase: "P-404", interim: "i" }],
    };
    const p = contractProblems(bad, ctx).join("\n");
    assert.match(p, /duplicate obligation\/deferral ids: O-1/);
    assert.match(p, /unknown requirement ids .*R-9\.99/);
    assert.match(p, /uncovered: R-1\.02/);
    assert.match(p, /unknown gate ids .*NOPE/);
    assert.match(p, /X-1: to_phase P-001 is not later than P-001/);
    assert.match(p, /X-2: to_phase P-404 is not a phase/);
    assert.match(contractProblems({ obligations: [], deferrals: [] }, ctx).join(";"), /no obligations/);
  });

  test("incoming deferrals must be covered or deferred again", () => {
    const incoming = [{ id: "X-1", requirements: [], what: "auth", to_phase: "P-002", interim: "i", from_phase: "P-001", ref: "P-001/X-1" }];
    const c2 = { phase: manifest.phases[1]!, manifest, incoming };
    const base = { obligations: [{ ...ob("O-1", ["R-2.01"]), gates: [] }], deferrals: [] };
    assert.match(contractProblems(base, c2).join(";"), /must be covered .*P-001\/X-1/);
    assert.deepEqual(contractProblems({ ...base, obligations: [{ ...base.obligations[0]!, covers: ["P-001/X-1"] }] }, c2), []);
  });

  test("every debate finding is dispositioned; an accepted one names contract ids", () => {
    const body = { obligations: [ob("O-1", ["R-1.01"])], deferrals: [] };
    assert.match(dispositionProblems(undefined, ["D-1", "D-2"], body).join(";"), /missing: D-1, D-2/);
    const p = dispositionProblems([{ id: "D-1", decision: "accept", reason: "r" }, { id: "D-2", decision: "accept", reason: "r", refs: ["O-9"] }], ["D-1", "D-2"], body).join(";");
    assert.match(p, /D-1 is accepted: refs must name/);
    assert.match(p, /D-2: refs O-9 are not in the contract/);
    assert.deepEqual(dispositionProblems([{ id: "D-1", decision: "reject", reason: "out of scope" }, { id: "D-2", decision: "accept", reason: "r", refs: ["O-1"] }], ["D-1", "D-2"], body), []);
  });

  test("amendments retire, replace and add; repair designs resolve every finding", () => {
    const c = newContract("P-001", { obligations: [ob("O-1", ["R-1.01"]), ob("O-2", ["R-1.02"])], deferrals: [] });
    const a = { obligations: [ob("O-2", ["R-1.02"], { statement: "new" }), ob("O-3", ["R-1.02"], { resolves: ["R-4"] })], retire: ["O-1"] };
    const n = amend(c, a);
    assert.equal(n.revision, 2);
    assert.deepEqual(n.obligations.map((o) => o.id), ["O-2", "O-3"]);
    assert.equal(n.obligations[0]!.statement, "new");
    assert.deepEqual(unresolvedByAmendment(a, ["R-4", "R-8"]), ["R-8"]);
    assert.deepEqual(unresolvedByAmendment(undefined, ["R-4"]), ["R-4"]);
  });
});

describe("tester evidence binding", () => {
  const xml = `<?xml version="1.0"?><testsuites><testsuite name="s" tests="3">
    <testcase name="it rejects a production url" class="Tests\\Feature\\SafetyTest" classname="Tests.Feature.SafetyTest" file="/repo/tests/Feature/SafetyTest.php::it rejects a production url"/>
    <testcase name="Status &gt; renders AR" classname="tests/js/status.test.tsx"><failure>boom</failure></testcase>
    <testcase name="skipped one" classname="x"><skipped/></testcase>
  </testsuite></testsuites>`;

  test("JUnit and verbose unittest testcases are read with their outcome", () => {
    const cases = junitCases(xml);
    assert.deepEqual(cases.map((c) => c.status), ["passed", "failed", "skipped"]);
    assert.equal(cases[1]!.name, "Status > renders AR");
    const u = unittestCases("test_valid (test_ids.TestIds.test_valid) ... ok\ntest_bad (test_ids.TestIds) ... FAIL\n\nRan 2 tests");
    assert.deepEqual(u.map((c) => [c.name, c.status]), [["test_valid", "passed"], ["test_bad", "failed"]]);
  });

  test("a verified claim must name a passing testcase of the gate run", () => {
    const index: CaseIndex = { available: true, cases: junitCases(xml) };
    const v = (tests: string[], status = "verified") => [{ id: "O-1", status, tests }];
    assert.deepEqual(unbackedTests(v(["it rejects a production url"]), index, "/repo"), []);
    assert.deepEqual(unbackedTests(v(["tests/Feature/SafetyTest.php::it rejects a production url"]), index, "/repo"), []);
    assert.deepEqual(unbackedTests(v(["Tests.Feature.SafetyTest::it rejects a production url"]), index, "/repo"), []);
    assert.match(unbackedTests(v(["Status > renders AR"]), index, "/repo")[0]!.reason, /failed in the gate evidence/);
    assert.match(unbackedTests(v(["skipped one"]), index, "/repo")[0]!.reason, /skipped/);
    assert.match(unbackedTests(v(["it rejects"]), index, "/repo")[0]!.reason, /no such testcase/);
    assert.deepEqual(unbackedTests(v(["anything"], "inspected"), index, "/repo"), []);
  });

  test("a review finding's proof needs, per check, a testcase that did not pass on the reviewed tree", () => {
    const reviewed = { available: true, cases: [{ name: "it rejects a production url", classname: "Tests.Feature.SafetyTest", file: "" }] };
    const open = new Set(["R-1"]);
    const v = (checks: { n: number; tests: string[] }[]) => [{ id: "R-1", status: "verified", tests: checks.flatMap((c) => c.tests), checks }];
    const stale = staleClaims(v([{ n: 1, tests: ["it rejects a production url"] }, { n: 2, tests: ["R-1 check 2: rejects a nested write host"] }]), open, reviewed, new Set(), "/repo");
    assert.equal(stale.length, 1);
    assert.match(stale[0]!.reason, /check 1: every cited testcase already passed on the reviewed tree/);
    assert.deepEqual(staleClaims(v([{ n: 1, tests: ["it rejects a production url", "R-1 check 1: rejects URL-free targets"] }]), open, reviewed, new Set(), "/repo"), []);
    assert.deepEqual(staleClaims([{ id: "R-1", status: "verified", tests: ["it rejects a production url"] }], new Set(["R-9"]), reviewed, new Set(), "/repo"), [], "only open review findings");
    assert.equal(staleClaims([{ id: "R-1", status: "verified", tests: ["it rejects a production url"] }], open, reviewed, new Set(), "/repo").length, 1, "without checks the finding as a whole");
    const files = { available: false, cases: [] };
    assert.deepEqual(staleClaims([{ id: "R-1", status: "verified", tests: ["tests/test_ids.py::test_valid"] }], open, files, new Set(["tests/test_ids.py"]), "/repo"), []);
    assert.equal(staleClaims([{ id: "R-1", status: "verified", tests: ["tests/test_ids.py::test_valid"] }], open, files, new Set(["noteapp.py"]), "/repo").length, 1);
  });

  test("without named testcases a claim must name an existing test file and a name in it", () => {
    const root = mkdtempSync(join(tmpdir(), "lr-bind-"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests/test_ids.py"), "def test_valid():\n    pass\n");
    const none: CaseIndex = { available: false, cases: [] };
    const v = (t: string) => [{ id: "O-1", status: "verified", tests: [t] }];
    assert.deepEqual(unbackedTests(v("tests/test_ids.py::test_valid"), none, root), []);
    assert.deepEqual(unbackedTests(v("tests/test_ids.py"), none, root), []);
    assert.match(unbackedTests(v("tests/test_ids.py::test_other"), none, root)[0]!.reason, /does not contain test_other/);
    assert.match(unbackedTests(v("test_valid"), none, root)[0]!.reason, /no such test file/);
  });
});
