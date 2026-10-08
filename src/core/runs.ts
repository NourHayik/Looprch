import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, Mode } from "./config.js";
import type { Role } from "./constants.js";
import type { Task } from "./briefs.js";
import type { ModeReason } from "./mode.js";
import { LrError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./fsx.js";
import { projectPaths } from "./paths.js";

export type RunStatus = "issued" | "running" | "completed" | "failed" | "timeout" | "aborted" | "unavailable" | "interrupted" | "rate_limited" | "usage_error" | "rejected";

export interface RunRecord {
  run_id: string;
  phase: string | null;
  stage: string;
  task: Task;
  role: Role;
  mode: Mode;
  effective_mode: Mode;
  mode_reason: ModeReason;
  agent: AgentId;
  model: string;
  effort: string | null;
  timeout: string;
  session_in: string | null;
  resume: boolean;
  attempt: number;
  status: RunStatus;
  side: boolean;
  read_only: boolean;
  packet: string | null;
  brief: string;
  pid: number | null;
  relay_path: string | null;
  relay_sha256: string | null;
  argv: string[] | null;
  started_at: string;
  finished_at: string | null;
  git_before: string | null;
  git_after: string | null;
  touched_files: string[];
  session_out: string | null;
  decision: string | null;
  question?: string;
  output_path?: string;
  error?: string;
  /** Usage telemetry (absent in runs issued before 0.7.0). */
  brief_bytes?: number;
  input_bytes?: number;
  result_bytes?: number;
  wall_ms?: number;
  /** Token usage as the relay reported it; null when the relay reports none. */
  usage?: Usage | null;
}

export interface Usage {
  input: number;
  cached_input: number;
  output: number;
  /** Where the numbers come from (relay result field or events file). */
  source: string;
}

export interface RoleUsage {
  role: Role;
  agent: AgentId;
  model: string;
  runs: number;
  wall_ms: number;
  brief_bytes: number;
  input_bytes: number;
  result_bytes: number;
  /** Runs whose relay reported token usage; the token sums cover only those. */
  runs_with_tokens: number;
  tokens: { input: number; cached_input: number; output: number };
}

/** Measured usage per role and model for one phase (or every run): wall time, bytes, and the tokens relays reported. */
export function usageSummary(root: string, phase: string | null): RoleUsage[] {
  const dir = projectPaths(root).runs;
  if (!existsSync(dir)) return [];
  const out = new Map<string, RoleUsage>();
  for (const id of readdirSync(dir)) {
    const p = join(dir, id, "run.json");
    if (!existsSync(p)) continue;
    let r: RunRecord;
    try {
      r = readJson<RunRecord>(p);
    } catch {
      continue;
    }
    if (!r.role || (phase && r.phase !== phase)) continue;
    const key = `${r.role}|${r.agent}|${r.model}`;
    const u = out.get(key) ?? { role: r.role, agent: r.agent, model: r.model, runs: 0, wall_ms: 0, brief_bytes: 0, input_bytes: 0, result_bytes: 0, runs_with_tokens: 0, tokens: { input: 0, cached_input: 0, output: 0 } };
    u.runs++;
    u.wall_ms += r.wall_ms ?? 0;
    u.brief_bytes += r.brief_bytes ?? 0;
    u.input_bytes += r.input_bytes ?? 0;
    u.result_bytes += r.result_bytes ?? 0;
    if (r.usage) {
      u.runs_with_tokens++;
      u.tokens.input += r.usage.input;
      u.tokens.cached_input += r.usage.cached_input;
      u.tokens.output += r.usage.output;
    }
    out.set(key, u);
  }
  return [...out.values()].sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model));
}

export function runPath(root: string, runId: string): string {
  return join(projectPaths(root).run(runId), "run.json");
}

export function loadRun(root: string, runId: string): RunRecord {
  const p = runPath(root, runId);
  if (!existsSync(p)) throw new LrError("unknown_run", `Unknown run ${runId}`);
  return readJson<RunRecord>(p);
}

export function saveRun(root: string, run: RunRecord): void {
  writeJsonAtomic(runPath(root, run.run_id), run);
}

export function relayOutDir(root: string, runId: string): string {
  return join(projectPaths(root).run(runId), "relay");
}
