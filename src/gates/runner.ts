import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import { ensureDir, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from "../core/fsx.js";
import { nowIso } from "../core/clock.js";
import { projectPaths } from "../core/paths.js";
import { sha256 } from "../install/manifest.js";
import type { Gate, PhaseDef } from "../sev3/manifest.js";
import { parseJunit } from "./junit.js";
import { parseUnittest, type Counts } from "./unittest.js";

export interface GateRun {
  gate_run_id: string;
  gate_id: string;
  kind: Gate["kind"];
  negative: boolean;
  argv: string[];
  cwd: ".";
  started_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  evidence: { format: Gate["evidence"]["format"]; path: string | null; sha256: string | null } & Counts;
  manual_report: string | null;
  stdout_path: string;
  stderr_path: string;
  stdout_tail: string;
  ok: boolean;
  reason: string | null;
  snapshot_tree: string;
}

export interface GatesFile {
  schema_version: 1;
  phase: string;
  runs: GateRun[];
  latest: Record<string, string>;
}

export function gatesPath(root: string, phase: string): string {
  return join(projectPaths(root).phase(phase), "gates.json");
}

export function loadGates(root: string, phase: string): GatesFile {
  return readJsonIfExists<GatesFile>(gatesPath(root, phase)) ?? { schema_version: 1, phase, runs: [], latest: {} };
}

function tail(text: string, lines = 20): string {
  return text.split("\n").slice(-lines).join("\n");
}

/** Run one gate as argv (no shell) and judge it by machine evidence only. */
export function runGate(root: string, cfg: Config, gate: Gate, gateRunId: string, outDir: string, snapshot: string, manualReport: string | null): GateRun {
  const started = Date.now();
  const startedAt = nowIso();
  const timeoutMs = (gate.timeout_seconds ?? 300) * 1000;
  const res = spawnSync(gate.command[0]!, gate.command.slice(1), {
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...cfg.gates.env },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  const stdoutPath = join(outDir, `${gate.id}.out`);
  const stderrPath = join(outDir, `${gate.id}.err`);
  writeFileAtomic(stdoutPath, stdout);
  writeFileAtomic(stderrPath, stderr);
  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || (res.signal === "SIGTERM" && Date.now() - started >= timeoutMs - 50);
  const run: GateRun = {
    gate_run_id: gateRunId,
    gate_id: gate.id,
    kind: gate.kind,
    negative: gate.negative,
    argv: gate.command,
    cwd: ".",
    started_at: startedAt,
    duration_ms: Date.now() - started,
    exit_code: res.status,
    signal: res.signal ?? null,
    timed_out: timedOut,
    evidence: { format: gate.evidence.format, path: gate.evidence.path ?? null, sha256: null, tests: 0, failures: 0, errors: 0, skipped: 0 },
    manual_report: manualReport,
    stdout_path: stdoutPath.slice(root.length + 1),
    stderr_path: stderrPath.slice(root.length + 1),
    stdout_tail: tail(`${stdout}\n${stderr}`.trim()),
    ok: false,
    reason: null,
    snapshot_tree: snapshot,
  };
  if (res.error && !timedOut) {
    run.reason = (res.error as NodeJS.ErrnoException).code === "ENOENT" ? `command not found: ${gate.command[0]}` : res.error.message;
    return run;
  }
  if (timedOut) {
    run.reason = `timed out after ${gate.timeout_seconds ?? 300} s`;
    return run;
  }
  const needsEvidence = gate.negative || gate.kind === "test" || gate.kind === "integration";
  switch (gate.evidence.format) {
    case "unittest": {
      const combined = `${stdout}\n${stderr}`;
      const p = parseUnittest(combined, res.status);
      Object.assign(run.evidence, p.counts, { sha256: sha256(combined) });
      run.ok = p.ok;
      run.reason = p.reason;
      break;
    }
    case "junit": {
      const rel = gate.evidence.path;
      const abs = rel ? join(root, rel) : null;
      if (!abs || !existsSync(abs)) {
        run.reason = `JUnit evidence ${rel ?? "(no path)"} was not written`;
        break;
      }
      if (statSync(abs).mtimeMs < started - 1000) {
        run.reason = `JUnit evidence ${rel} is older than this gate run (stale)`;
        break;
      }
      const xml = readFileSync(abs, "utf8");
      const p = parseJunit(xml);
      Object.assign(run.evidence, p.counts, { sha256: sha256(xml) });
      run.ok = p.ok && res.status === 0;
      run.reason = p.reason ?? (res.status !== 0 ? `exit code ${res.status}` : null);
      break;
    }
    case "none": {
      if (needsEvidence) {
        run.reason = "this gate needs machine evidence but declares format none";
        break;
      }
      run.ok = res.status === 0;
      run.reason = run.ok ? null : `exit code ${res.status}`;
      run.evidence.sha256 = sha256(stdout);
      break;
    }
    default: {
      const never: never = gate.evidence.format;
      run.reason = `unknown evidence format ${String(never)}`;
    }
  }
  if (run.ok && gate.kind === "manual" && !manualReport) {
    run.ok = false;
    run.reason = "manual gate needs a Tester or Reviewer inspection report (manual_gate_reports)";
  }
  if (run.ok && gate.kind === "manual" && manualReport && !existsSync(join(root, manualReport))) {
    run.ok = false;
    run.reason = `inspection report ${manualReport} does not exist`;
  }
  return run;
}

export interface GatesOutcome {
  phase: string;
  snapshot_tree: string;
  all_passed: boolean;
  results: { gate_run_id: string; gate_id: string; ok: boolean; reason: string | null }[];
  runs: GateRun[];
}

export function runPhaseGates(root: string, cfg: Config, phase: PhaseDef, snapshot: string, manualReports: Record<string, string>): GatesOutcome {
  const paths = projectPaths(root);
  ensureDir(paths.testEvidence);
  ensureDir(paths.reports);
  const file = loadGates(root, phase.id);
  const batch = new Set(file.runs.map((r) => r.gate_run_id.split("-g-")[1]?.split(".")[0])).size + 1;
  const outDir = join(paths.runs, `${phase.id}-gates-${batch}`);
  ensureDir(outDir);
  const runs: GateRun[] = [];
  let n = file.runs.length;
  for (const gate of phase.gates) {
    n++;
    const r = runGate(root, cfg, gate, `${phase.id}-g-${n}`, outDir, snapshot, manualReports[gate.id] ?? null);
    runs.push(r);
    file.runs.push(r);
    file.latest[gate.id] = r.gate_run_id;
  }
  writeJsonAtomic(gatesPath(root, phase.id), file);
  return { phase: phase.id, snapshot_tree: snapshot, all_passed: runs.every((r) => r.ok), results: runs.map((r) => ({ gate_run_id: r.gate_run_id, gate_id: r.gate_id, ok: r.ok, reason: r.reason })), runs };
}
