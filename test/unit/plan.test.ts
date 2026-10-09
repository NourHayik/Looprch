import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { readRelayUsage } from "../../src/delegate/usage.js";
import { addEntries, applyDispositions, applyVerdicts, closeEntries, ledgerSummary, newLedger, openEntries } from "../../src/core/debate.js";
import { incomingDeferrals, newPlan, normalizeSessions, savePlan, unmappedRequirements } from "../../src/core/plan.js";
import { defaultE2e, e2eProblems } from "../../src/core/config.js";
import { initialState } from "../../src/core/state.js";
import { e2eArgv, e2eEnv, e2eSelected, e2eSetupProblems } from "../../src/gates/e2e.js";
import { E2E_PROVIDERS, ensureGitignored, hasE2eTests, installCommand, missingEnvLines, providerEnvKeys, readEnvFile, renderE2eConfig, renderEnvFile, type E2eInitOptions } from "../../src/gates/e2e-setup.js";
import { nodeSupported } from "../../src/cli/e2e.js";
import { cachedOutcome } from "../../src/gates/runner.js";
import { sha256 } from "../../src/install/manifest.js";
import type { Manifest, PhaseDef } from "../../src/sev3/manifest.js";

const dir = () => mkdtempSync(join(tmpdir(), "lr-plan-"));
const todos = (...ids: string[]) => ids.map((id) => ({ id, title: `do ${id}` }));

describe("plan sessions", () => {
  test("one session with every todo when the Planner gives none", () => {
    assert.deepEqual(normalizeSessions({ todos: todos("T-1", "T-2", "T-3") }), { sessions: [["T-1", "T-2", "T-3"]], notes: [] });
  });
  test("the Planner's grouping is kept as given", () => {
    assert.deepEqual(normalizeSessions({ todos: todos("T-1", "T-2", "T-3"), sessions: [["T-1", "T-2"], ["T-3"]] }).sessions, [["T-1", "T-2"], ["T-3"]]);
  });
  test("unknown and repeated ids are dropped, empty sessions removed, unlisted todos join the last session, with notes", () => {
    const n = normalizeSessions({ todos: todos("T-1", "T-2", "T-3", "T-4"), sessions: [["T-1", "T-9"], ["T-1"], ["T-2"]] });
    assert.deepEqual(n.sessions, [["T-1"], ["T-2", "T-3", "T-4"]]);
    assert.match(n.notes.join(";"), /dropped unknown todo id T-9/);
    assert.match(n.notes.join(";"), /appended todos no session listed to the last session: T-3, T-4/);
  });
});

describe("plan files", () => {
  const phase = { id: "P-002", requirements: ["R-1", "R-2", "R-3"] } as unknown as PhaseDef;
  test("requirements the map does not mention are a hint for the Debater; deferrals count", () => {
    assert.deepEqual(unmappedRequirements({ todos: todos("T-1"), requirements: { "R-1": ["T-1"], "R-2": [] }, deferrals: [{ id: "X-1", what: "w", to_phase: "P-003", requirements: ["R-3"] }] }, phase), ["R-2"]);
    assert.deepEqual(unmappedRequirements(null, phase), ["R-1", "R-2", "R-3"]);
  });
  test("plan.json keeps earlier revisions; incoming deferrals come from closed phases (plan.json, or contract.json before 0.8)", () => {
    const root = dir();
    mkdirSync(join(root, ".looprch/phases/P-001"), { recursive: true });
    mkdirSync(join(root, ".looprch/phases/P-000"), { recursive: true });
    savePlan(root, newPlan("P-001", { todos: todos("T-1"), deferrals: [{ id: "X-1", what: "auth", to_phase: "P-002", interim: "deny" }] }));
    savePlan(root, newPlan("P-001", { todos: todos("T-1"), deferrals: [{ id: "X-1", what: "auth", to_phase: "P-002", interim: "deny" }] }, 2));
    assert.ok(readFileSync(join(root, ".looprch/phases/P-001/plan.r0.json"), "utf8").includes('"revision": 1'));
    writeFileSync(join(root, ".looprch/phases/P-000/contract.json"), JSON.stringify({ deferrals: [{ id: "X-1", what: "audit", to_phase: "P-002", interim: "log" }] }));
    const st = initialState();
    st.phases["P-000"] = { status: "closed", started_at: "", closed_at: "", merge_commit: null, tag: null, rounds_used: 0, implementers: [] };
    st.phases["P-001"] = { ...st.phases["P-000"]! };
    const manifest = { phases: [{ id: "P-000" }, { id: "P-001" }, { id: "P-002" }] } as unknown as Manifest;
    assert.deepEqual(incomingDeferrals(root, manifest, st, "P-002").map((d) => d.ref), ["P-000/X-1", "P-001/X-1"]);
  });
});

describe("debate ledger", () => {
  test("items close through a verdict, agreement, a user decision or an explicit note; ids are never reused", () => {
    const l = newLedger("P-001");
    l.rounds = 1;
    addEntries(l, [{ id: "D-1", source: "debater", severity: "high", summary: "no store decided", round: 1 }, { id: "D-2", source: "debater", severity: "medium", summary: "vague task", round: 1 }, { id: "D-1", source: "debater", severity: "low", summary: "dup id", round: 1 }]);
    assert.deepEqual(l.entries.map((e) => e.id), ["D-1", "D-2", "D-1.2"]);
    applyDispositions(l, [{ id: "D-1", decision: "accept", note: "SQLite" }, { id: "D-2", decision: "reject", note: "the plan says it" }]);
    l.rounds = 2;
    applyVerdicts(l, [{ id: "D-1", verdict: "upheld", note: "still open" }, { id: "D-2", verdict: "conceded" }]);
    assert.deepEqual(openEntries(l).map((e) => e.id), ["D-1", "D-1.2"]);
    closeEntries(openEntries(l), "contested", "limit");
    const s = ledgerSummary(l);
    assert.equal(s.conceded, 1);
    assert.equal(s.contested, 2);
    assert.equal(s.contract_changes, 1, "one plan revision");
    assert.equal(s.readbacks, 0, "status --json keeps the field");
    assert.equal(l.yield.find((y) => y.round === 2)?.upheld, 1);
  });
});

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

describe("e2e setup (looprch e2e init)", () => {
  const opts = (provider: keyof typeof E2E_PROVIDERS, over: Partial<E2eInitOptions> = {}): E2eInitOptions => ({ provider: E2E_PROVIDERS[provider], model: E2E_PROVIDERS[provider].defaultModel, url: "http://localhost:3000", start: null, readyUrl: null, baseUrl: null, ...over });

  test("the config loads .env.e2e and builds the provider's model; no model for locator-only tests", () => {
    const c = renderE2eConfig(opts("openrouter", { start: "npm run dev", readyUrl: "http://localhost:3000/health" }));
    assert.match(c, /import \{ openrouter \} from '@openrouter\/ai-sdk-provider';/);
    assert.match(c, /if \(existsSync\('\.env\.e2e'\)\) process\.loadEnvFile\('\.env\.e2e'\);/);
    assert.match(c, /model: openrouter\(process\.env\.E2E_MODEL \|\| 'openai\/gpt-6-luna-fast'\)/);
    assert.match(c, /url: process\.env\.APP_URL \|\| 'http:\/\/localhost:3000'/);
    assert.match(c, /command: \{ executable: 'npm', args: \['run', 'dev'\] \},\n      readyUrl: 'http:\/\/localhost:3000\/health',/);
    const none = renderE2eConfig(opts("none"));
    assert.doesNotMatch(none, /agents|ai-sdk|command/);
    assert.match(renderE2eConfig(opts("openai-compatible", { model: "qwen3" })), /createOpenAICompatible\(\{ name: 'custom', baseURL: process\.env\.E2E_BASE_URL \|\| '', apiKey: process\.env\.E2E_API_KEY \|\| undefined \}\)\.chatModel\(process\.env\.E2E_MODEL \|\| 'qwen3'\)/);
  });

  test("the keys file lists every key with where to get it; the gate requires only the required ones", () => {
    const env = renderEnvFile(opts("openrouter"));
    assert.match(env, /never commit it/);
    assert.match(env, /# Your OpenRouter API key\. Get it: https:\/\/openrouter\.ai\/keys\nOPENROUTER_API_KEY=\n/);
    assert.deepEqual(parseEnv(env), { APP_URL: "http://localhost:3000", OPENROUTER_API_KEY: "", E2E_MODEL: "openai/gpt-6-luna-fast" });
    assert.deepEqual(providerEnvKeys(E2E_PROVIDERS["openai-compatible"]).filter((k) => k.required).map((k) => k.name), ["E2E_BASE_URL", "E2E_MODEL"]);
    assert.deepEqual(providerEnvKeys(E2E_PROVIDERS.none), []);
    assert.match(missingEnvLines("APP_URL=x\nOPENROUTER_API_KEY=sk\n", opts("openrouter")), /^\n# The model id[^\n]*\nE2E_MODEL=openai\/gpt-6-luna-fast\n$/);
    assert.equal(missingEnvLines(env, opts("openrouter")), "");
  });

  test("runs read the keys file; a variable exported in the shell wins; an empty key is reported with the file to fill", () => {
    const root = dir();
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(root, "node_modules/.bin/e2e"), "");
    writeFileSync(join(root, "e2e.config.ts"), "");
    writeFileSync(join(root, ".env.e2e"), "OPENROUTER_API_KEY=\nE2E_MODEL=m\nLR_TEST_SHELL_WINS=file\n");
    const cfg = { gates: { env: {} } } as never;
    const e2e = { ...defaultE2e(), required_env: ["OPENROUTER_API_KEY", "E2E_MODEL"] };
    assert.match(e2eSetupProblems(root, cfg, e2e)!.reason, /not filled in yet: OPENROUTER_API_KEY\. Put the value\(s\) in \.env\.e2e/);
    writeFileSync(join(root, ".env.e2e"), "OPENROUTER_API_KEY=sk-or\nE2E_MODEL=m\nLR_TEST_SHELL_WINS=file\n");
    assert.equal(e2eSetupProblems(root, cfg, e2e), null);
    process.env.LR_TEST_SHELL_WINS = "shell";
    try {
      assert.equal(e2eEnv(root, cfg, e2e).LR_TEST_SHELL_WINS, "shell");
    } finally {
      delete process.env.LR_TEST_SHELL_WINS;
    }
    assert.equal(readEnvFile(dir()).OPENROUTER_API_KEY, undefined);
  });

  test("gitignore, existing tests and the package manager are detected", () => {
    const root = dir();
    assert.equal(ensureGitignored(root, ".env.e2e"), true);
    assert.equal(ensureGitignored(root, ".env.e2e"), false);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), ".env.e2e\n");
    assert.equal(hasE2eTests(root), false);
    mkdirSync(join(root, "tests/ui"), { recursive: true });
    writeFileSync(join(root, "tests/ui/login.e2e.ts"), "");
    assert.equal(hasE2eTests(root), true);
    assert.deepEqual(installCommand(root, ["e2e"]), ["npm", "install", "-D", "e2e"]);
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    assert.deepEqual(installCommand(root, ["e2e"]), ["pnpm", "add", "-D", "e2e"]);
  });
});
