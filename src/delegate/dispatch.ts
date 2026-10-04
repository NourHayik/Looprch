import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { LrError } from "../core/errors.js";
import { sleep, nowIso } from "../core/clock.js";
import { writeJsonAtomic } from "../core/fsx.js";
import { pidAlive, withLock } from "../core/lock.js";
import { finalizeRun, loadEngine, persist } from "../core/lifecycle.js";
import { projectPaths } from "../core/paths.js";
import { loadRun, relayOutDir, type RunRecord } from "../core/runs.js";
import { ensureDir } from "../core/fsx.js";
import { adapterFor } from "../agents/index.js";
import type { RelayInfo } from "./locate.js";

export interface ArgvResult {
  argv: string[];
  warnings: string[];
}

/** Relay argv from run data and adapter capabilities. Lanes are never used (D-15). */
export function buildRelayArgv(root: string, run: RunRecord, relay: RelayInfo): ArgvResult {
  const d = adapterFor(run.agent).delegate;
  if (!d) throw new LrError("delegate_unsupported", `${run.agent} has no relay`);
  const warnings: string[] = [];
  const argv = [relay.path, "--brief", resolve(root, run.brief), "--cd", root, "--out-dir", relayOutDir(root, run.run_id), "--timeout", run.timeout];
  if (run.model) argv.push("--model", run.model);
  if (run.effort) {
    if (d.effortFlag) argv.push(d.effortFlag, run.effort);
    else warnings.push(`${run.agent}-delegate has no effort flag; effort "${run.effort}" was not passed`);
  }
  if (run.read_only) {
    if (d.readOnly !== "none") argv.push("--read-only");
    else warnings.push(`${run.agent}-delegate cannot run read-only; git status is checked before and after`);
  }
  if (run.resume && run.session_in) argv.push(d.resumeFlag, run.session_in);
  if (d.cleanEnv) argv.push("--clean-env");
  return { argv, warnings };
}

/** Start the detached wrapper process that runs the relay and records its exit. */
export function spawnWrapper(root: string, runId: string): number {
  const script = process.argv[1]!;
  const child = spawn(process.execPath, [script, "_run-relay", runId, "--root", root], { cwd: root, detached: true, stdio: "ignore", env: process.env });
  child.unref();
  if (!child.pid) throw new LrError("spawn_failed", "Could not start the relay wrapper process");
  return child.pid;
}

export function exitPath(root: string, runId: string): string {
  return join(projectPaths(root).run(runId), "exit.json");
}

export async function waitForRun(root: string, runId: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (existsSync(exitPath(root, runId))) return true;
    const run = loadRun(root, runId);
    if (run.status !== "running") return true;
    if (run.pid && !pidAlive(run.pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(250, Math.max(10, deadline - Date.now())));
  }
}

/** Finalize under the project lock, retrying while another Looprch command holds it. */
export async function finalizeWithLock(root: string, runId: string, attempts = 240): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await withLock(root, null, `finalize ${runId}`, () => {
        const run = loadRun(root, runId);
        if (run.status !== "running") return false;
        const e = loadEngine(root, null);
        finalizeRun(e, run);
        persist(e);
        return true;
      });
    } catch (err) {
      if ((err as LrError).code !== "lock_busy") throw err;
      await sleep(500);
    }
  }
  return false;
}

/** Body of the hidden `_run-relay` command: run the relay, write exit.json, record the result. */
export async function relayWrapper(root: string, runId: string): Promise<number> {
  const run = loadRun(root, runId);
  if (!run.argv) throw new LrError("not_dispatched", `Run ${runId} has no relay argv`);
  const dir = projectPaths(root).run(runId);
  ensureDir(relayOutDir(root, runId));
  const out = openSync(join(dir, "relay.stdout"), "a");
  const err = openSync(join(dir, "relay.stderr"), "a");
  const child = spawn(process.execPath, run.argv, { cwd: root, stdio: ["ignore", out, err], env: process.env });
  const forward = (sig: NodeJS.Signals) => () => {
    try {
      child.kill(sig);
    } catch {
      // child already gone
    }
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
    child.on("exit", (c, s) => res([c, s]));
    child.on("error", () => res([127, null]));
  });
  closeSync(out);
  closeSync(err);
  writeJsonAtomic(exitPath(root, runId), { code, signal, at: nowIso(), relay_pid: child.pid ?? null });
  await finalizeWithLock(root, runId);
  return 0;
}
