import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, initRepo } from "../helpers/tmp.js";
import { readRelayUsage } from "../../src/delegate/usage.js";
import { testIntegrityProblems } from "../../src/gates/integrity.js";
import { addEntries, applyDispositions, applyVerdicts, closeEntries, ledgerSummary, newLedger, openEntries } from "../../src/core/debate.js";
import { traceabilityMarkdown } from "../../src/core/trace.js";
import { newContract } from "../../src/core/contract.js";
import { defaultE2e, e2eProblems } from "../../src/core/config.js";
import { e2eArgv, e2eSelected } from "../../src/gates/e2e.js";
import { nodeSupported } from "../../src/cli/e2e.js";
import { cachedOutcome } from "../../src/gates/runner.js";
import { sha256 } from "../../src/install/manifest.js";
import type { PhaseDef } from "../../src/sev3/manifest.js";

const dir = () => mkdtempSync(join(tmpdir(), "lr-v07-"));

describe("relay usage (measured, never estimated)", () => {
  test("cursor result.json usage", () => {
    const d = dir();
    writeFileSync(join(d, "result.json"), JSON.stringify({ status: "completed", usage: { inputTokens: 72595, outputTokens: 26742, cacheReadTokens: 1842176, cacheWriteTokens: 0 } }));
    assert.deepEqual(readRelayUsage(d), { input: 72595, cached_input: 1842176, output: 26742, source: "result.usage" });
  });
  test("codex turn.completed usage (input includes the cached part)", () => {
    const d = dir();
    writeFileSync(join(d, "result.json"), JSON.stringify({ status: "completed" }));
    writeFileSync(join(d, "events.jsonl"), `${JSON.stringify({ type: "turn.started" })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } })}\n`);
    assert.deepEqual(readRelayUsage(d), { input: 100, cached_input: 900, output: 50, source: "events.turn.completed" });
  });
  test("opencode per-step tokens are summed; a partial last line is ignored", () => {
    const d = dir();
    const step = (input: number, output: number, reasoning: number, read: number) => JSON.stringify({ type: "step_finish", part: { tokens: { input, output, reasoning, cache: { read, write: 0 } } } });
    writeFileSync(join(d, "events.jsonl"), `${step(10, 5, 2, 100)}\n${step(20, 1, 0, 200)}\n{"type":"step_fin`);
    assert.deepEqual(readRelayUsage(d), { input: 30, cached_input: 300, output: 8, source: "events.part.tokens" });
  });
  test("no usage reported gives null", () => {
    const d = dir();
    writeFileSync(join(d, "result.json"), JSON.stringify({ status: "completed" }));
    assert.equal(readRelayUsage(d), null);
  });
});

describe("test integrity scan", () => {
  test("skip and focus markers added to test files are found; justified ones and app code are not", () => {
    const d = dir();
    initRepo(d);
    mkdirSync(join(d, "tests"), { recursive: true });
    writeFileSync(join(d, "tests/a.test.ts"), "it('a', () => {});\n");
    writeFileSync(join(d, "app.ts"), "export const x = 1;\n");
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", "base"]);
    const base = git(d, ["rev-parse", "HEAD"]);
    writeFileSync(join(d, "tests/a.test.ts"), "it.only('a', () => {});\nit.skip('b', () => {}); // looprch-allow-skip: needs a GPU\n");
    writeFileSync(join(d, "tests/UserTest.php"), "<?php\n$this->markTestSkipped('later');\n");
    writeFileSync(join(d, "tests/test_x.py"), "@pytest.mark.skip\ndef test_x(): pass\n");
    writeFileSync(join(d, "app.ts"), "export const x = 1; // it.only( is not a test here\n");
    git(d, ["add", "-A"]);
    const tree = git(d, ["write-tree"]);
    const found = testIntegrityProblems(d, base, tree);
    assert.deepEqual(found.map((x) => [x.file, x.marker]).sort(), [["tests/UserTest.php", "PHPUnit/Pest skip"], ["tests/a.test.ts", "focus/skip (.only/.skip/.todo)"], ["tests/test_x.py", "pytest/unittest skip"]].sort());
  });
});

describe("gate caching by tree", () => {
  test("the latest runs are reused only when all passed on this exact tree with unchanged JUnit evidence and no manual gate", () => {
    const root = dir();
    mkdirSync(join(root, ".looprch/phases/P-001"), { recursive: true });
    mkdirSync(join(root, ".looprch/test-evidence"), { recursive: true });
    const xml = '<testsuite tests="1" failures="0" errors="0"><testcase name="a" classname="t"/></testsuite>';
    writeFileSync(join(root, ".looprch/test-evidence/u.xml"), xml);
    const g = (id: string, kind: "test" | "manual" = "test") => ({ id, kind, command: ["true"], negative: false, requirements: [], evidence: { format: "junit" as const, path: ".looprch/test-evidence/u.xml" } });
    const run = (gate: string, n: number, ok: boolean, tree: string) => ({ gate_run_id: `P-001-g-${n}`, gate_id: gate, ok, snapshot_tree: tree, reason: ok ? null : "failed", evidence: { format: "junit", path: ".looprch/test-evidence/u.xml", sha256: sha256(xml), tests: 1, failures: 0, errors: 0, skipped: 0 } });
    const write = (runs: object[], latest: Record<string, string>) => writeFileSync(join(root, ".looprch/phases/P-001/gates.json"), JSON.stringify({ schema_version: 1, phase: "P-001", runs, latest }));
    const phase = { id: "P-001", gates: [g("G-1"), g("G-2")] } as unknown as PhaseDef;
    write([run("G-1", 1, true, "t1"), run("G-2", 2, true, "t1")], { "G-1": "P-001-g-1", "G-2": "P-001-g-2" });
    const hit = cachedOutcome(root, phase, "t1");
    assert.equal(hit?.cached, true);
    assert.deepEqual(hit?.runs.map((r) => r.gate_run_id), ["P-001-g-1", "P-001-g-2"]);
    assert.equal(cachedOutcome(root, phase, "t2"), null, "another tree runs the gates");
    write([run("G-1", 1, true, "t1"), run("G-2", 2, false, "t1")], { "G-1": "P-001-g-1", "G-2": "P-001-g-2" });
    assert.equal(cachedOutcome(root, phase, "t1"), null, "a failing latest run is never reused");
    write([run("G-1", 1, true, "t1"), run("G-2", 2, true, "t1")], { "G-1": "P-001-g-1", "G-2": "P-001-g-2" });
    writeFileSync(join(root, ".looprch/test-evidence/u.xml"), xml.replace('tests="1"', 'tests="2"'));
    assert.equal(cachedOutcome(root, phase, "t1"), null, "changed evidence runs the gates");
    assert.equal(cachedOutcome(root, { ...phase, gates: [g("G-1", "manual")] } as unknown as PhaseDef, "t1"), null, "manual gates are never cached");
  });
});

describe("debate ledger", () => {
  test("items close only through a verdict, a user decision or an explicit note; ids are never reused", () => {
    const l = newLedger("P-001");
    addEntries(l, [{ id: "L-1", source: "lint", severity: "medium", summary: "vague", round: 0 }]);
    l.rounds = 1;
    addEntries(l, [{ id: "D-1", source: "debater", severity: "high", summary: "no trust source", round: 1 }, { id: "L-1", source: "debater", severity: "low", summary: "dup id", round: 1 }]);
    assert.deepEqual(l.entries.map((e) => e.id), ["L-1", "D-1", "L-1.2"]);
    applyDispositions(l, [{ id: "D-1", decision: "accept", reason: "r", refs: ["O-1"] }, { id: "L-1", decision: "reject", reason: "fine", evidence: "packet" }], 2);
    l.rounds = 2;
    applyVerdicts(l, [{ id: "D-1", verdict: "upheld", note: "still open" }, { id: "L-1", verdict: "conceded" }]);
    assert.deepEqual(openEntries(l).map((e) => e.id), ["D-1", "L-1.2"]);
    closeEntries(openEntries(l), "contested", "limit");
    const s = ledgerSummary(l);
    assert.equal(s.conceded, 1);
    assert.equal(s.contested, 2);
    assert.equal(s.contract_changes, 2);
    assert.equal(l.yield.find((y) => y.round === 2)?.upheld, 1);
  });
});

describe("traceability matrix", () => {
  test("requirement to obligation, decision, package, planned test, Tester verdict and review status", () => {
    const phase = { id: "P-001", requirements: ["R-1", "R-2"] } as unknown as PhaseDef;
    const contract = newContract("P-001", {
      obligations: [{ id: "O-1", requirements: ["R-1"], kind: "boundary", statement: "s", rule: "only x", enforcement: "e", verify: "v", gates: [] }],
      deferrals: [],
      decisions: [{ id: "AD-1", decision: "d", rationale: "r", rejected_alternatives: [], requirements: [], obligations: ["O-1"] }],
      interfaces: [],
      work_packages: [{ id: "WP-1", title: "t", obligations: ["O-1"], precision: "full_content", files: [{ path: "a", action: "create", content: "c", blueprint: true }], steps: ["s"], done_when: ["d"], tests: [{ id: "T-1", obligation: "O-1", kind: "adversarial", given: "g", when: "w", then: "t", file: "f" }] }],
    });
    const md = traceabilityMarkdown(phase, contract, { tester_verifications: [{ id: "T-1", status: "verified", tests: ["f::t1"], variants: [] }, { id: "O-1", status: "verified", tests: ["f::t1"], variants: [] }], contract_review: [{ id: "O-1", status: "met" }] });
    assert.match(md, /\| R-1 \| O-1 \| boundary \| AD-1 \| WP-1 \| T-1 \(adversarial\): verified: f::t1 \| verified: f::t1 \| met \|/);
    assert.match(md, /\| R-2 \| \*\*uncovered\*\* \|/);
  });
});

describe("e2e configuration", () => {
  test("shape checks, enable needs configure, Looprch owns --config/--reporter/--output, Node support", () => {
    assert.deepEqual(e2eProblems(defaultE2e()), []);
    assert.match(e2eProblems({ ...defaultE2e(), enabled: true }).join(";"), /enabled before it was configured/);
    assert.match(e2eProblems({ ...defaultE2e(), args: ["--output", "x"] }).join(";"), /must not set --config, --reporter or --output/);
    assert.match(e2eProblems({ ...defaultE2e(), bin: "../outside/e2e" }).join(";"), /bin must be a path inside the project/);
    assert.match(e2eProblems({ ...defaultE2e(), phases: ["P-1"] }).join(";"), /phases must be "all" or a list of phase ids/);
    assert.deepEqual(e2eArgv({ ...defaultE2e(), args: ["--tag", "smoke"] }, ".looprch/runs/x/e2e"), ["node_modules/.bin/e2e", "run", "--config", "e2e.config.ts", "--reporter", "list,junit", "--output", ".looprch/runs/x/e2e", "--tag", "smoke"]);
    const on = { ...defaultE2e(), enabled: true, configured_at: "2026-10-08T00:00:00Z", phases: ["P-002"] };
    assert.equal(e2eSelected(on, "P-002"), true);
    assert.equal(e2eSelected(on, "P-001"), false);
    assert.equal(e2eSelected({ ...on, enabled: false }, "P-002"), false);
    assert.equal(e2eSelected(undefined, "P-002"), false);
    assert.deepEqual(["22.22.2", "22.22.3", "23.1.0", "24.7.9", "24.8.0", "25.0.0"].map(nodeSupported), [false, true, false, false, true, true]);
  });
});
