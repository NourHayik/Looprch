import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { LrError } from "./errors.js";
import { ensureDir, writeFileAtomic } from "./fsx.js";
import { nowIso } from "./clock.js";
import { projectPaths } from "./paths.js";

export interface LockInfo {
  pid: number;
  hostname: string;
  host_agent: string | null;
  command: string;
  started: string;
  heartbeat: string;
}

const held = new Map<string, { depth: number; timer: NodeJS.Timeout }>();

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(root: string): LockInfo | null {
  const path = projectPaths(root).lock;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/**
 * Returns true when a stale lock was reclaimed. Waits up to `waitMs` for a live holder on this
 * machine (Looprch locks are held for seconds), then throws with exit code 3.
 */
export function acquireLock(root: string, hostAgent: string | null, command: string, waitMs = 20_000): boolean {
  const path = projectPaths(root).lock;
  const existing = held.get(path);
  if (existing) {
    existing.depth++;
    return false;
  }
  ensureDir(projectPaths(root).lr);
  let reclaimed = false;
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    const info: LockInfo = {
      pid: process.pid,
      hostname: hostname(),
      host_agent: hostAgent,
      command,
      started: nowIso(),
      heartbeat: nowIso(),
    };
    try {
      const fd = openSync(path, "wx", 0o644);
      writeSync(fd, `${JSON.stringify(info)}\n`);
      closeSync(fd);
      const timer = setInterval(() => {
        try {
          writeFileAtomic(path, `${JSON.stringify({ ...info, heartbeat: nowIso() })}\n`);
        } catch {
          // heartbeat is advisory
        }
      }, 5000);
      timer.unref();
      held.set(path, { depth: 1, timer });
      return reclaimed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(root);
      const stale = !holder || (holder.hostname === hostname() && !pidAlive(holder.pid));
      if (stale) {
        rmSync(path, { force: true });
        reclaimed = true;
        continue;
      }
      if (holder.hostname === hostname() && Date.now() < deadline && attempt < 100_000) {
        sleepSync(50);
        continue;
      }
      throw new LrError(
        "lock_busy",
        `Another Looprch process holds the project lock: pid ${holder.pid} on ${holder.hostname} (${holder.command}, host ${holder.host_agent ?? "unknown"}, since ${holder.started})`,
        holder.hostname === hostname()
          ? "Wait for it to finish. If that process is gone, run the command again."
          : "The lock belongs to another machine. Remove .looprch/lock only if you are sure no Lead is running there.",
        3,
        holder,
      );
    }
  }
}

export function releaseLock(root: string): void {
  const path = projectPaths(root).lock;
  const entry = held.get(path);
  if (!entry) return;
  entry.depth--;
  if (entry.depth > 0) return;
  clearInterval(entry.timer);
  held.delete(path);
  rmSync(path, { force: true });
}

export async function withLock<T>(
  root: string,
  hostAgent: string | null,
  command: string,
  fn: (reclaimed: boolean) => Promise<T> | T,
  waitMs?: number,
): Promise<T> {
  const reclaimed = acquireLock(root, hostAgent, command, waitMs);
  try {
    return await fn(reclaimed);
  } finally {
    releaseLock(root);
  }
}
