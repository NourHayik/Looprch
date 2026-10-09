import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import { ensureDir, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from "../core/fsx.js";
import { nowIso } from "../core/clock.js";
import { projectPaths } from "../core/paths.js";
import { sha256 } from "../install/manifest.js";
import { VERSION } from "../core/constants.js";
import { head } from "../git/git.js";
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
  finished_at?: string;
  duration_ms: number;
  /** The program that ran the gate and judged its evidence. */
  runner?: { name: "looprch"; version: string };
  /** HEAD when the gate ran; `snapshot_tree` also covers uncommitted and new files. */
  head_commit?: string | null;
  stdout_sha256?: string;
  stderr_sha256?: string;
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
export function runGate(root: string, cfg: Config, gate: Gate, gateRunId: string, outDir: string, snapshot: string, manualReport: string | null, headCommit: string | null = null): GateRun {
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
    finished_at: nowIso(),
    duration_ms: Date.now() - started,
    runner: { name: "looprch", version: VERSION },
    head_commit: headCommit,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
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
  /** The runs are the latest passing runs on this same tree (nothing was executed). */
  cached?: boolean;
}

/**
 * The latest run of every gate when all of them passed on exactly this tree and their JUnit
 * evidence is unchanged; null otherwise. Gates are deterministic on a tree, so running them again
 * (for example after a Tester-only evidence round that changed no file) proves nothing new.
 * Manual gates are never cached.
 */
export function cachedOutcome(root: string, phase: PhaseDef, snapshot: string): GatesOutcome | null {
  if (!phase.gates.length || phase.gates.some((g) => g.kind === "manual")) return null;
  const file = loadGates(root, phase.id);
  const runs = phase.gates.map((g) => file.runs.find((r) => r.gate_run_id === file.latest[g.id]));
  if (runs.some((r) => !r || !r.ok || r.snapshot_tree !== snapshot)) return null;
  for (const r of runs as GateRun[]) {
    if (r.evidence.format !== "junit") continue;
    const abs = r.evidence.path ? join(root, r.evidence.path) : null;
    if (!abs || !existsSync(abs) || sha256(readFileSync(abs, "utf8")) !== r.evidence.sha256) return null;
  }
  const list = runs as GateRun[];
  return { phase: phase.id, snapshot_tree: snapshot, all_passed: true, results: list.map((r) => ({ gate_run_id: r.gate_run_id, gate_id: r.gate_id, ok: r.ok, reason: r.reason })), runs: list, cached: true };
}

/** Append a run Looprch made outside the SEV3 gates (the optional e2e gate) to gates.json. */
export function recordExtraRun(root: string, phaseId: string, run: GateRun): void {
  const file = loadGates(root, phaseId);
  file.runs.push(run);
  file.latest[run.gate_id] = run.gate_run_id;
  writeJsonAtomic(gatesPath(root, phaseId), file);
}

/** Directory and next gate run id for a run outside the SEV3 batch. */
export function extraRunSlot(root: string, phaseId: string): { outDir: string; gateRunId: string } {
  const n = loadGates(root, phaseId).runs.length + 1;
  return { outDir: join(projectPaths(root).runs, `${phaseId}-e2e-${n}`), gateRunId: `${phaseId}-g-${n}` };
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
  const headCommit = head(root);
  for (const gate of phase.gates) {
    n++;
    const r = runGate(root, cfg, gate, `${phase.id}-g-${n}`, outDir, snapshot, manualReports[gate.id] ?? null, headCommit);
    runs.push(r);
    file.runs.push(r);
    file.latest[gate.id] = r.gate_run_id;
  }
  writeJsonAtomic(gatesPath(root, phase.id), file);
  return { phase: phase.id, snapshot_tree: snapshot, all_passed: runs.every((r) => r.ok), results: runs.map((r) => ({ gate_run_id: r.gate_run_id, gate_id: r.gate_id, ok: r.ok, reason: r.reason })), runs };
}
