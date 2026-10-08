import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amend, blueprintsIn, contractChanges, contractProblems, dispositionProblems, executabilityProblems, newContract, orderWork, PLAN_HEADINGS, planLint, repairPackageProblems, unresolvedByAmendment, workPackageProblems, type ContractBody, type WorkItem } from "../../src/core/contract.js";
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
    assert.match(dispositionProblems([{ id: "D-1", decision: "reject", reason: "out of scope" }], ["D-1"], body).join(";"), /D-1 is rejected: "evidence" must cite/);
    assert.deepEqual(dispositionProblems([{ id: "D-1", decision: "reject", reason: "out of scope", evidence: "packet: P-002 owns auth" }, { id: "D-2", decision: "accept", reason: "r", refs: ["O-1"] }], ["D-1", "D-2"], body), []);
  });

  test("an accepted debate item must change one of its refs; partial counts like accept", () => {
    const before = { obligations: [ob("O-1", ["R-1.01"]), ob("O-2", ["R-1.02"])], deferrals: [] };
    const after = { ...before, obligations: [{ ...ob("O-1", ["R-1.01"]), statement: "rejects empty ids" }, ob("O-2", ["R-1.02"])] };
    assert.deepEqual(contractChanges(before, after), { added: [], changed: ["O-1"], removed: [] });
    assert.deepEqual(dispositionProblems([{ id: "D-1", decision: "accept", reason: "r", refs: ["O-1"] }], ["D-1"], after, before), []);
    assert.match(dispositionProblems([{ id: "D-1", decision: "accept", reason: "r", refs: ["O-2"] }], ["D-1"], after, before).join(";"), /none of its refs \(O-2\) changed/);
    assert.match(dispositionProblems([{ id: "D-1", decision: "partial", reason: "r", refs: ["O-2"] }], ["D-1"], after, before).join(";"), /partly accepted, but none of its refs/);
    const added = { ...after, decisions: [{ id: "AD-1", decision: "d", rationale: "r", rejected_alternatives: [], requirements: [], obligations: ["O-1"] }] };
    assert.deepEqual(dispositionProblems([{ id: "D-1", decision: "accept", reason: "r", refs: ["AD-1"] }], ["D-1"], added, before), [], "a new decision counts as a change");
  });

  test("executability: planned tests per obligation, closed rules get a failing case, boundary packages carry blueprints", () => {
    const t = (id: string, obligation: string, kind: "positive" | "adversarial" = "positive") => ({ id, obligation, kind, given: "g", when: "w", then: "t", file: "tests/t.py" });
    const wp = (over: Partial<WorkItem>): WorkItem => ({ id: "WP-1", title: "t", obligations: ["O-1", "O-2"], precision: "spec", files: [{ path: "a.py", action: "create", content: "c" }], steps: ["s"], done_when: ["d"], tests: [t("T-1", "O-1")], ...over });
    const body = { obligations: [ob("O-1", ["R-1.01"]), { ...ob("O-2", ["R-1.02"]), kind: "boundary" as const, rule: "only x" }], deferrals: [], decisions: [], interfaces: [] };
    const p = executabilityProblems({ ...body, work_packages: [wp({})] }).join("\n");
    assert.match(p, /needs a planned test .*none for: O-2/);
    assert.match(p, /WP-1 builds a boundary \(O-2\): precision must be "full_content"/);
    const p2 = executabilityProblems({ ...body, work_packages: [wp({ precision: "full_content", tests: [t("T-1", "O-1"), t("T-2", "O-2")] })] }).join("\n");
    assert.match(p2, /mark the critical files "blueprint": true/);
    assert.match(p2, /only positive tests for: O-2/);
    const ok = wp({ precision: "full_content", files: [{ path: "a.py", action: "create", content: "c", blueprint: true }], tests: [t("T-1", "O-1"), t("T-2", "O-2", "adversarial")], decisions: ["AD-9"] });
    assert.deepEqual(executabilityProblems({ ...body, work_packages: [ok] }), ["WP-1: decisions AD-9 are not in contract.decisions"]);
  });

  test("plan lint: paths exist, nothing TBD, blueprints present, required sections, vague wording per package", () => {
    const sections = PLAN_HEADINGS.map((h) => `## ${h}\n\nNone.`).join("\n\n");
    const wps = [
      { id: "WP-1", title: "t", obligations: [], precision: "spec" as const, files: [{ path: "new.py", action: "create" as const, content: "c" }, { path: "gone.py", action: "modify" as const, content: "c" }], steps: ["Handle errors as appropriate.", "Write f"], done_when: ["TBD"], tests: [] },
      { id: "WP-2", title: "t", depends_on: ["WP-1"], obligations: [], precision: "full_content" as const, files: [{ path: "new.py", action: "modify" as const, content: "c" }, { path: "app/g.py", action: "create" as const, content: "c", blueprint: true }], steps: ["Copy the blueprint."], done_when: ["d"], tests: [] },
    ];
    const r = planLint({ obligations: [], deferrals: [], work_packages: wps }, `# Plan\n\n${sections}\n`, (p) => p === "exists.py");
    assert.ok(r.errors.some((e) => /WP-1 done_when 1: "TBD"/.test(e)), r.errors.join("\n"));
    assert.ok(r.errors.some((e) => /WP-1: modify gone.py, but the file does not exist/.test(e)));
    assert.ok(!r.errors.some((e) => /WP-2: modify new.py/.test(e)), "an earlier package creates it");
    assert.ok(r.errors.some((e) => /WP-2: app\/g.py is a blueprint, but the report has no/.test(e)));
    assert.deepEqual(r.ambiguities.map((a) => [a.package, a.phrases]), [["WP-1", ["as appropriate"]]]);
    const withBlueprint = planLint({ obligations: [], deferrals: [], work_packages: [wps[1]!] }, `${sections}\n\n\`\`\`python blueprint=app/g.py\ndef g():\n    return 1\n\`\`\`\n`, (p) => p === "new.py");
    assert.deepEqual(withBlueprint.errors, []);
    assert.equal(blueprintsIn("```python blueprint=app/g.py\ndef g():\n    return 1\n```\n").get("app/g.py"), "def g():\n    return 1\n");
    assert.match(planLint({ obligations: [], deferrals: [], work_packages: [] }, "## Objectives\n", () => true).errors.join(";"), /the report \(the markdown above the looprch-result block\) needs these sections .*Decisions/);
    const domain = planLint({ obligations: [], deferrals: [], work_packages: [{ ...wps[0]!, files: [{ path: "new.py", action: "create", content: "Status enum TODO, DONE; ids P-XXX" }], steps: ["Add the TODO status."], done_when: ["d"] }] }, sections, () => false);
    assert.deepEqual(domain.errors, [], "domain words (a TODO status, P-XXX ids) are not markers");
    assert.match(planLint({ obligations: [], deferrals: [], work_packages: [{ ...wps[0]!, files: [{ path: "new.py", action: "create", content: "c" }], steps: ["TODO: pick the parser"], done_when: ["d"] }] }, sections, () => false).errors.join(";"), /"TODO:" leaves the work undecided/);
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

describe("work and repair packages", () => {
  const w = (id: string, extra: Partial<WorkItem> = {}): WorkItem => ({ id, title: id, obligations: ["O-1"], files: [{ path: "a.php", action: "create", content: "class A { public function f(): int }" }], steps: ["write A"], done_when: ["php -l a.php"], ...extra });

  test("every obligation is implemented by a package; ids, dependencies and order are checked", () => {
    const obs = [ob("O-1", ["R-1.01"]), ob("O-2", ["R-1.02"])];
    assert.match(workPackageProblems([w("WP-1")], obs).join(";"), /none for: O-2/);
    assert.match(workPackageProblems([w("WP-1", { obligations: ["O-9"] })], obs).join(";"), /unknown obligations or deferrals: O-9/);
    assert.match(workPackageProblems([w("WP-1"), w("WP-1", { obligations: ["O-2"] })], obs).join(";"), /duplicate work package ids: WP-1/);
    assert.match(workPackageProblems([w("WP-1", { depends_on: ["WP-2"] }), w("WP-2", { depends_on: ["WP-1"], obligations: ["O-2"] })], obs).join(";"), /cycle/);
    assert.match(workPackageProblems([w("WP-1", { depends_on: ["WP-7"] }), w("WP-2", { obligations: ["O-2"] })], obs).join(";"), /unknown work packages: WP-1 -> WP-7/);
    assert.match(workPackageProblems([], obs).join(";"), /no work_packages/);
    assert.deepEqual(workPackageProblems([w("WP-1")], obs, false), [], "an amendment's new obligations are built by repair packages");
    assert.deepEqual(orderWork([w("WP-2", { depends_on: ["WP-1"] }), w("WP-1"), w("WP-3")])!.map((x) => x.id), ["WP-1", "WP-2", "WP-3"]);
  });

  test("retiring an obligation removes it from the packages; packages may build deferral interims or scaffolding", () => {
    const c = newContract("P-001", { obligations: [ob("O-1", ["R-1.01"]), ob("O-2", ["R-1.02"])], deferrals: [{ id: "X-1", requirements: [], what: "auth", to_phase: "P-002", interim: "dependency_unavailable" }], work_packages: [w("WP-1"), w("WP-2", { obligations: ["O-2", "X-1"] }), w("WP-0", { obligations: [] })] });
    const n = amend(c, { obligations: [ob("O-3", ["R-1.02"], { resolves: ["R-4"] })], retire: ["O-2"] });
    assert.deepEqual(n.work_packages!.find((x) => x.id === "WP-2")!.obligations, ["X-1"]);
    assert.deepEqual(contractProblems(n, ctx, { amended: true }), []);
    assert.match(contractProblems(n, ctx).join(";"), /none for: O-3/, "outside a repair design a new obligation needs a package");
  });

  test("a repair design repairs every finding in bounded packages", () => {
    assert.match(repairPackageProblems([w("RP-1", { findings: ["R-1", "R-9"] })], ["R-1"]).join(";"), /may only repair this design's findings .*not: R-9/);
    assert.match(repairPackageProblems(undefined, ["R-1"]).join(";"), /returns "repair_packages"/);
    assert.match(repairPackageProblems([w("RP-1", { findings: ["R-1"] })], ["R-1", "R-2"]).join(";"), /missing: R-2/);
    assert.deepEqual(repairPackageProblems([w("RP-1", { findings: ["R-1"] }), w("RP-2", { findings: ["R-2"], depends_on: ["RP-1"] })], ["R-1", "R-2"]), []);
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
