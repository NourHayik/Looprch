import { existsSync } from "node:fs";
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
