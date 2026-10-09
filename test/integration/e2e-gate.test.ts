import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, git, runCli } from "../helpers/tmp.js";
import { drive, readJson, setupProject, type Project } from "../helpers/lead.js";

const cli = (p: Project, args: string[], env: NodeJS.ProcessEnv = p.env) => runCli([...args, "--json"], { cwd: p.root, env });

/** A project with the fake `e2e` CLI in node_modules/.bin and an e2e.config.ts. */
function withE2e(): Project {
  const p = setupProject();
  mkdirSync(join(p.root, "node_modules/.bin"), { recursive: true });
  copyFileSync(join(FIXTURES, "fake-e2e", "e2e.mjs"), join(p.root, "node_modules/.bin/e2e"));
  chmodSync(join(p.root, "node_modules/.bin/e2e"), 0o755);
  writeFileSync(join(p.root, "e2e.config.ts"), "export default { targets: [] };\n");
  appendFileSync(join(p.root, ".gitignore"), "\nnode_modules/\n");
  git(p.root, ["add", "-A"]);
  git(p.root, ["commit", "-qm", "e2e setup"]);
  return p;
}

describe("optional e2e gate (TesterArmy e2e)", { concurrency: 2 }, () => {
  test("enable before configure is refused; configure checks the setup; disable keeps the configuration", () => {
    const p = withE2e();
    const early = cli(p, ["e2e", "enable"]);
    assert.equal(early.code, 1);
    assert.equal(early.json.error.code, "e2e_not_configured");
    assert.match(early.json.error.hint, /\/lr-e2e-test-init/);
    const viaConfig = cli(p, ["config", "set", "integrations.e2e.enabled", "true"]);
    assert.equal(viaConfig.json.error.code, "e2e_not_configured");
    const noTests = cli(p, ["e2e", "configure"], { ...p.env, FAKE_E2E_NO_TESTS: "1" });
    assert.equal(noTests.code, 1);
    assert.match(noTests.json.problems.join(";"), /e2e list selects no test/);
    const missingEnv = cli(p, ["e2e", "configure", "--require-env", "LR_TEST_MODEL_KEY"]);
    assert.match(missingEnv.json.problems.join(";"), /not filled in yet: LR_TEST_MODEL_KEY\. Put the value\(s\) in \.env\.e2e/);
    assert.equal(readJson(join(p.root, ".looprch/config.json")).integrations.e2e, undefined, "nothing is saved until the checks pass");
    const ok = cli(p, ["e2e", "configure", "--timeout", "2m", "--phases", "P-001,P-002"]);
    assert.equal(ok.code, 0, JSON.stringify(ok.json));
    assert.equal(ok.json.tests, 1);
    assert.equal(ok.json.config.enabled, false, "configure alone does not enable");
    assert.equal(cli(p, ["e2e", "enable"]).json.enabled, true);
    const st = cli(p, ["e2e", "status"]).json;
    assert.equal(st.enabled, true);
    assert.equal(st.configured, true);
    assert.deepEqual(st.config.phases, ["P-001", "P-002"]);
    assert.equal(cli(p, ["e2e", "disable"]).json.enabled, false);
    assert.ok(readJson(join(p.root, ".looprch/config.json")).integrations.e2e.configured_at, "disable keeps the configuration");
    assert.equal(cli(p, ["e2e", "enable"]).json.enabled, true, "re-enable without reconfiguring");
    const doctor = cli(p, ["doctor", "--quick"]).json.checks.find((c: any) => c.id === "e2e");
    assert.equal(doctor.status, "ok");
    p.s.cleanup();
  });

  test("enabled: the gate runs after the SEV3 gates pass, its JUnit evidence lands in gates.json, and it does not run again on the same tree", () => {
    const p = withE2e();
    const log = join(mkdtempSync(join(tmpdir(), "lr-e2e-")), "calls.log");
    const env = { ...p.env, FAKE_E2E_LOG: log };
    assert.equal(cli(p, ["e2e", "configure", "--enable", "--arg=--target", "--arg=web"], env).code, 0);
    const r = drive({ root: p.root, env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed", JSON.stringify(r.last));
    const gates = readJson(join(p.root, ".looprch/phases/P-001/gates.json"));
    const e2e = gates.runs.filter((x: any) => x.gate_id === "LR-E2E");
    assert.equal(e2e.length, 1, "the handover did not change the tree, so the passing e2e run is not repeated");
    assert.equal(e2e[0].ok, true);
    assert.equal(e2e[0].evidence.tests, 1);
    assert.deepEqual(e2e[0].argv.slice(0, 6), ["node_modules/.bin/e2e", "run", "--config", "e2e.config.ts", "--reporter", "list,junit"]);
    assert.deepEqual(e2e[0].argv.slice(-2), ["--target", "web"]);
    const runs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a: string[]) => a[0] === "run");
    assert.equal(runs.length, 1);
    assert.ok(r.progress.some((l) => /LR-E2E/.test(l) || /gates passed/.test(l)));
    p.s.cleanup();
  });

  test("a failing e2e test goes to the normal repair round; the repaired tree passes", () => {
    const p = withE2e();
    const counter = join(mkdtempSync(join(tmpdir(), "lr-e2e-")), "n");
    const env = { ...p.env, FAKE_E2E_FAIL_TIMES: "1", FAKE_E2E_COUNTER: counter };
    assert.equal(cli(p, ["e2e", "configure", "--enable"], env).code, 0);
    const r = drive({ root: p.root, env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed", JSON.stringify(r.last));
    const seq = r.actions.filter((a) => a.action === "run_role").map((a) => `${a.role}:${a.task}`);
    assert.ok(seq.includes("implementer:repair"), seq.join(" "));
    const gates = readJson(join(p.root, ".looprch/phases/P-001/gates.json"));
    const e2e = gates.runs.filter((x: any) => x.gate_id === "LR-E2E");
    assert.deepEqual(e2e.map((x: any) => x.ok), [false, true]);
    assert.match(e2e[0].reason, /1 e2e test\(s\) failed|tests failed/);
    p.s.cleanup();
  });

  test("a configuration error (exit 2) or an environment failure (exit 3, timeout) blocks with a fix hint, not a repair; disable and resume continue", () => {
    for (const [extra, code] of [[{ FAKE_E2E_EXIT: "2" }, "e2e_config"], [{ FAKE_E2E_EXIT: "3" }, "e2e_environment"], [{ FAKE_E2E_SLEEP_MS: "4000" }, "e2e_environment"]] as const) {
      const p = withE2e();
      const env = { ...p.env, ...extra };
      assert.equal(cli(p, ["e2e", "configure", "--enable", "--timeout", "2s"], p.env).code, 0);
      const r = drive({ root: p.root, env, scope: "phase" });
      assert.equal(r.last.action, "blocked");
      assert.equal(r.last.code, code, JSON.stringify(r.last));
      assert.match(r.last.hint, /looprch e2e disable/);
      assert.ok(!r.actions.some((a) => a.action === "run_role" && a.task === "repair"), "no repair for an infrastructure problem");
      cli(p, ["e2e", "disable"]);
      cli(p, ["resume"]);
      const r2 = drive({ root: p.root, env, scope: "phase" });
      assert.equal(r2.last.action, "phase_closed", JSON.stringify(r2.last));
      p.s.cleanup();
    }
  });

  test("a missing e2e binary blocks e2e_missing; a run that writes no report fails", () => {
    const p = withE2e();
    assert.equal(cli(p, ["e2e", "configure", "--enable"]).code, 0);
    const cfg = readJson(join(p.root, ".looprch/config.json"));
    cfg.integrations.e2e.bin = "node_modules/.bin/missing-e2e";
    writeFileSync(join(p.root, ".looprch/config.json"), JSON.stringify(cfg, null, 2));
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.code, "e2e_missing", JSON.stringify(r.last));
    p.s.cleanup();

    const q = withE2e();
    const env = { ...q.env, FAKE_E2E_NO_REPORT: "1" };
    assert.equal(cli(q, ["e2e", "configure", "--enable"], env).code, 0);
    const r2 = drive({ root: q.root, env, scope: "phase", maxSteps: 40, stopOn: ["blocked"], onAction: (a) => (a.action === "run_role" && a.task === "repair" ? "stop" : undefined) });
    assert.equal(r2.last.task, "repair");
    const gates = readJson(join(q.root, ".looprch/phases/P-001/gates.json"));
    assert.match(gates.runs.find((x: any) => x.gate_id === "LR-E2E").reason, /wrote no junit\.xml/);
    q.s.cleanup();
  });

  test("e2e init writes the keys file, a first test and the gate; configure --enable passes once the key is filled in", () => {
    const p = withE2e();
    assert.notEqual(cli(p, ["e2e", "init"]).code, 0, "without a terminal the provider must be named");
    const r = cli(p, ["e2e", "init", "--provider", "openrouter", "--url", "http://localhost:4000", "--yes"]);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.ok, false);
    assert.deepEqual(r.json.missing_keys, ["OPENROUTER_API_KEY"]);
    assert.equal(r.json.files["e2e.config.ts"], "kept (pass --force to replace it; a .bak is written)");
    assert.equal(r.json.files[".env.e2e"], "written");
    assert.equal(r.json.files["tests/e2e/smoke.e2e.ts"], "written");
    assert.match(r.json.next.join("\n"), /Open \.env\.e2e and fill in: OPENROUTER_API_KEY \(your OpenRouter API key; get it at https:\/\/openrouter\.ai\/keys\)/);
    assert.match(readFileSync(join(p.root, ".env.e2e"), "utf8"), /APP_URL=http:\/\/localhost:4000\n[\s\S]*OPENROUTER_API_KEY=\n/);
    assert.equal(git(p.root, ["check-ignore", ".env.e2e"]), ".env.e2e", "the keys file is never committed");
    const saved = readJson(join(p.root, ".looprch/config.json")).integrations.e2e;
    assert.deepEqual(saved.required_env, ["OPENROUTER_API_KEY", "E2E_MODEL"]);
    assert.equal(saved.configured_at, null);
    assert.equal(cli(p, ["e2e", "enable"]).json.error.code, "e2e_not_configured");
    writeFileSync(join(p.root, ".env.e2e"), readFileSync(join(p.root, ".env.e2e"), "utf8").replace("OPENROUTER_API_KEY=\n", "OPENROUTER_API_KEY=sk-or-test\n"));
    const ok = cli(p, ["e2e", "configure", "--enable"]);
    assert.equal(ok.code, 0, JSON.stringify(ok.json));
    assert.equal(ok.json.config.enabled, true);
    const forced = cli(p, ["e2e", "init", "--provider", "none", "--force", "--enable", "--yes"]);
    assert.equal(forced.json.ok, true, JSON.stringify(forced.json));
    assert.equal(forced.json.enabled, true, "no key needed: init configures and enables in one step");
    assert.equal(readFileSync(join(p.root, "e2e.config.ts.bak"), "utf8"), "export default { targets: [] };\n");
    assert.doesNotMatch(readFileSync(join(p.root, "e2e.config.ts"), "utf8"), /agents/);
    p.s.cleanup();
  });

  test("disabled or unconfigured: gates.json has no e2e run", () => {
    const p = setupProject();
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const gates = readJson(join(p.root, ".looprch/phases/P-001/gates.json"));
    assert.ok(!gates.runs.some((x: any) => x.gate_id === "LR-E2E"));
    assert.equal(cli(p, ["e2e", "status"]).json.configured, false);
    p.s.cleanup();
  });
});
