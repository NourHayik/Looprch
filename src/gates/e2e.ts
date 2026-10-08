import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config, E2eConfig } from "../core/config.js";
import { nowIso, parseDuration } from "../core/clock.js";
import { VERSION } from "../core/constants.js";
import { ensureDir, writeFileAtomic } from "../core/fsx.js";
import { sha256 } from "../install/manifest.js";
import { parseJunit } from "./junit.js";
import type { GateRun } from "./runner.js";

/** Gate id of the optional TesterArmy e2e run in gates.json. */
export const E2E_GATE_ID = "LR-E2E";

/**
 * How a run ended. `pass` and `fail` are test verdicts (the JUnit report is the evidence);
 * `config` (exit 2) and `missing` need the user; `environment` (exit 3, timeout) and `runner`
 * (exit 4, signal) are infrastructure. Exit codes per the e2e CLI reference (spike S-11).
 */
export type E2eOutcome = "pass" | "fail" | "config" | "missing" | "environment" | "runner";

export interface E2eResult {
  run: GateRun;
  outcome: E2eOutcome;
}

/** True when the e2e gate runs for this phase: enabled, configured, and the phase selected. */
export function e2eSelected(e2e: E2eConfig | undefined, phaseId: string): e2e is E2eConfig {
  return !!e2e && e2e.enabled && e2e.configured_at !== null && (e2e.phases === "all" || e2e.phases.includes(phaseId));
}

/** Problems that keep the configured gate from running at all (checked before every run and by `looprch e2e configure`). */
export function e2eSetupProblems(root: string, cfg: Config, e2e: E2eConfig): { outcome: "config" | "missing"; reason: string } | null {
  if (!existsSync(join(root, e2e.bin))) return { outcome: "missing", reason: `${e2e.bin} does not exist: install the e2e package in the project (npm i -D e2e @e2e-dev/web), then run looprch e2e configure` };
  if (!existsSync(join(root, e2e.config))) return { outcome: "config", reason: `the e2e config ${e2e.config} does not exist` };
  const env = { ...process.env, ...cfg.gates.env, ...e2e.env };
  const unset = e2e.required_env.filter((k) => !env[k]);
  if (unset.length) return { outcome: "config", reason: `required environment variable(s) not set: ${unset.join(", ")} (export them before running Looprch, or set gates.env)` };
  return null;
}

/** The argv Looprch runs; the output directory is fresh for every run (a stopped run keeps the previous report, spike S-11). */
export function e2eArgv(e2e: E2eConfig, outputRel: string): string[] {
  return [e2e.bin, "run", "--config", e2e.config, "--reporter", "list,junit", "--output", outputRel, ...e2e.args];
}

export function runE2eGate(root: string, cfg: Config, e2e: E2eConfig, gateRunId: string, outDir: string, snapshot: string, headCommit: string | null): E2eResult {
  const started = Date.now();
  const startedAt = nowIso();
  const outAbs = join(outDir, "e2e");
  rmSync(outAbs, { recursive: true, force: true });
  ensureDir(outDir);
  const outRel = outAbs.slice(root.length + 1);
  const junitRel = `${outRel}/junit.xml`;
  const argv = e2eArgv(e2e, outRel);
  const run: GateRun = {
    gate_run_id: gateRunId,
    gate_id: E2E_GATE_ID,
    kind: "integration",
    negative: false,
    argv,
    cwd: ".",
    started_at: startedAt,
    duration_ms: 0,
    runner: { name: "looprch", version: VERSION },
    head_commit: headCommit,
    exit_code: null,
    signal: null,
    timed_out: false,
    evidence: { format: "junit", path: junitRel, sha256: null, tests: 0, failures: 0, errors: 0, skipped: 0 },
    manual_report: null,
    stdout_path: join(outDir, `${E2E_GATE_ID}.out`).slice(root.length + 1),
    stderr_path: join(outDir, `${E2E_GATE_ID}.err`).slice(root.length + 1),
    stdout_tail: "",
    ok: false,
    reason: null,
    snapshot_tree: snapshot,
  };
  const setup = e2eSetupProblems(root, cfg, e2e);
  if (setup) {
    writeFileAtomic(join(root, run.stdout_path), "");
    writeFileAtomic(join(root, run.stderr_path), `${setup.reason}\n`);
    run.reason = setup.reason;
    run.finished_at = nowIso();
    return { run, outcome: setup.outcome };
  }
  const timeoutMs = parseDuration(e2e.timeout);
  const res = spawnSync(join(root, e2e.bin), argv.slice(1), {
    cwd: root,
    env: { ...process.env, ...cfg.gates.env, ...e2e.env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  writeFileAtomic(join(root, run.stdout_path), stdout);
  writeFileAtomic(join(root, run.stderr_path), stderr);
  run.finished_at = nowIso();
  run.duration_ms = Date.now() - started;
  run.exit_code = res.status;
  run.signal = res.signal ?? null;
  run.stdout_sha256 = sha256(stdout);
  run.stderr_sha256 = sha256(stderr);
  run.stdout_tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-20).join("\n");
  run.timed_out = (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (res.signal === "SIGTERM" && Date.now() - started >= timeoutMs - 50);
  if (run.timed_out) {
    run.reason = `timed out after ${e2e.timeout}`;
    return { run, outcome: "environment" };
  }
  if (res.error) {
    run.reason = res.error.message;
    return { run, outcome: "runner" };
  }
  const junit = join(root, junitRel);
  const fresh = existsSync(junit) && statSync(junit).mtimeMs >= started - 1000;
  if (fresh) {
    const xml = readFileSync(junit, "utf8");
    const p = parseJunit(xml);
    Object.assign(run.evidence, p.counts, { sha256: sha256(xml) });
    if (res.status === 0) {
      run.ok = p.ok;
      run.reason = p.reason;
      return { run, outcome: p.ok ? "pass" : "fail" };
    }
  }
  switch (res.status) {
    case 0:
      run.reason = "e2e exited 0 but wrote no junit.xml for this run";
      return { run, outcome: "fail" };
    case 1:
      run.reason = fresh ? `${run.evidence.failures + run.evidence.errors} e2e test(s) failed` : "e2e test or setup failure (exit 1) without a report";
      return { run, outcome: "fail" };
    case 2:
      run.reason = "e2e configuration, collection, dependency or credential error (exit 2)";
      return { run, outcome: "config" };
    case 3:
      run.reason = "e2e engine, app process or model provider failure (exit 3)";
      return { run, outcome: "environment" };
    default:
      run.reason = `e2e runner failure (exit ${res.status ?? res.signal})`;
      return { run, outcome: "runner" };
  }
}
