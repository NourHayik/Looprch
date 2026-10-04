import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { ensureDir } from "./fsx.js";
import { nowIso } from "./clock.js";
import { projectPaths } from "./paths.js";

export const EVENT_TYPES = [
  "init.discovered",
  "init.gates_acknowledged",
  "config.changed",
  "phase.started",
  "preflight.passed",
  "preflight.failed",
  "stage.entered",
  "run.issued",
  "run.dispatched",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.reask",
  "result.accepted",
  "result.rejected",
  "expansion.executed",
  "context.over_budget",
  "mode.auto_delegate",
  "readonly.violation",
  "gates.run",
  "gate.result",
  "checkpoint.committed",
  "quota.checked",
  "quota.wait",
  "quota.fallback",
  "ratelimit.detected",
  "question.asked",
  "question.answered",
  "paused",
  "resumed",
  "blocked",
  "todo.ticked",
  "handover.accepted",
  "phase.merged",
  "phase.closed",
  "project.done",
  "spec.changed",
  "protocol.mismatch",
  "lock.stale_recovered",
  "warning",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface LrEvent {
  v: 1;
  seq: number;
  ts: string;
  type: EventType;
  phase: string | null;
  stage: string | null;
  role: string | null;
  agent: string | null;
  run_id: string | null;
  data: Record<string, unknown>;
}

export type EventInput = Partial<Omit<LrEvent, "v" | "seq" | "ts" | "type">> & { type: EventType };

interface Tail {
  lastSeq: number;
  partialFrom: number | null;
}

function readTail(fd: number): Tail {
  const size = fstatSync(fd).size;
  if (size === 0) return { lastSeq: 0, partialFrom: null };
  const len = Math.min(size, 65536);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, size - len);
  const text = buf.toString("utf8");
  let partialFrom: number | null = null;
  let body = text;
  if (!text.endsWith("\n")) {
    const cut = text.lastIndexOf("\n");
    partialFrom = size - len + Buffer.byteLength(text.slice(0, cut + 1));
    body = text.slice(0, cut + 1);
  }
  const lines = body.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]!) as LrEvent;
      if (typeof ev.seq === "number") return { lastSeq: ev.seq, partialFrom };
    } catch {
      // keep scanning backwards
    }
  }
  return { lastSeq: 0, partialFrom };
}

export function appendEvent(root: string, input: EventInput): LrEvent {
  const path = projectPaths(root).events;
  ensureDir(projectPaths(root).lr);
  const fd = openSync(path, existsSync(path) ? "r+" : "w+");
  try {
    const tail = readTail(fd);
    if (tail.partialFrom !== null) ftruncateSync(fd, tail.partialFrom);
    const ev: LrEvent = {
      v: 1,
      seq: tail.lastSeq + 1,
      ts: nowIso(),
      type: input.type,
      phase: input.phase ?? null,
      stage: input.stage ?? null,
      role: input.role ?? null,
      agent: input.agent ?? null,
      run_id: input.run_id ?? null,
      data: input.data ?? {},
    };
    const line = Buffer.from(`${JSON.stringify(ev)}\n`);
    const pos = fstatSync(fd).size;
    writeSync(fd, line, 0, line.length, pos);
    fsyncSync(fd);
    return ev;
  } finally {
    closeSync(fd);
  }
}

export interface ReadResult {
  events: LrEvent[];
  warnings: string[];
}

export function readEvents(root: string, opts: { phase?: string; limit?: number; type?: string } = {}): ReadResult {
  const path = projectPaths(root).events;
  if (!existsSync(path)) return { events: [], warnings: [] };
  const raw = readFileSync(path, "utf8");
  const warnings: string[] = [];
  const lines = raw.split("\n");
  const events: LrEvent[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      events.push(JSON.parse(line) as LrEvent);
    } catch {
      const isLast = i === lines.length - 1;
      warnings.push(isLast ? "Ignored a truncated last journal line" : `Ignored an unreadable journal line ${i + 1}`);
    }
  });
  let out = events;
  if (opts.phase) out = out.filter((e) => e.phase === opts.phase);
  if (opts.type) out = out.filter((e) => e.type === opts.type);
  if (opts.limit !== undefined) out = out.slice(-opts.limit);
  return { events: out, warnings };
}
