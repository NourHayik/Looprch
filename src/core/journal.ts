import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { ensureDir, writeJsonAtomic } from "./fsx.js";
import { nowIso } from "./clock.js";
import { projectPaths } from "./paths.js";
import type { Task } from "./briefs.js";
import type { ModeReason } from "./mode.js";
import type { QuestionKind, Stage } from "./state.js";

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
  "assignment.changed",
  "ratelimit.detected",
  "question.asked",
  "question.answered",
  "paused",
  "resumed",
  "blocked",
  "todo.ticked",
  "review.skipped",
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

export function lastSeq(root: string): number {
  const path = projectPaths(root).events;
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  try {
    return readTail(fd).lastSeq;
  } finally {
    closeSync(fd);
  }
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

// ---------------------------------------------------------------------------------------------
// progress lines the Lead posts in the chat

/**
 * First journal seq after the last one reported to the Lead. The cursor is machine-local
 * (under the gitignored runs/ directory); without one, reporting starts at `fallback` or the
 * journal's end.
 */
export function progressStart(root: string, fallback?: number): number {
  const path = projectPaths(root).progress;
  try {
    const saved = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { reported_seq?: unknown }).reported_seq : undefined;
    if (typeof saved === "number") return saved;
  } catch {
    // an unreadable cursor restarts at the journal's end
  }
  return fallback ?? lastSeq(root);
}

/** Progress lines for the journal events after `from`; advances the cursor. Call under the project lock. */
export function takeProgress(root: string, from: number): string[] {
  const events = readEvents(root).events.filter((x) => x.seq > from);
  if (!events.length) return [];
  writeJsonAtomic(projectPaths(root).progress, { reported_seq: events[events.length - 1]!.seq });
  return renderProgress(events);
}

interface ReportedFinding {
  id: string;
  severity?: string;
  summary: string;
}

const ROLE_NAMES: Record<string, string> = { planner: "Planner", plan_debater: "Plan Debater", implementer: "Implementer", tester: "Tester", reviewer: "Reviewer", worker: "Worker" };

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

const MODE_REASONS: Record<ModeReason, string | null> = {
  configured: null,
  d05_auto_delegate: null,
  quota_fallback: "fallback: quota",
  rate_limit_fallback: "fallback: rate limit",
  run_failed_fallback: "fallback: earlier runs failed",
  unavailable_fallback: "fallback: primary agent unavailable",
  user_choice: "your choice",
};

const QUESTIONS: Record<QuestionKind, string> = {
  commit_baseline: "Commit a clean git baseline before the first phase?",
  ack_gates: "Acknowledge the gate commands that will run on this machine?",
  approve_plan: "Approve the plan?",
  approve_merge: "Approve the merge of this phase?",
  context_over_budget: "A packet is above the agent's context budget: continue or use a fallback?",
  host_conflict: "Which agent is the Lead running in?",
  rate_limit_long: "An agent has been rate-limited for a long time: keep waiting or pause?",
};

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const roleName = (role: string | null): string => (role ? (ROLE_NAMES[role] ?? role) : "Role");
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const block = (...lines: string[]): string => lines.join("\n");

function clip(text: string, max = 200): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function lastLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}

function severities(v: unknown): string {
  const counts = (v && typeof v === "object" ? v : {}) as Record<string, number>;
  const parts = SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  return parts.length ? `: ${parts.join(", ")}` : "";
}

function findingsText(d: Record<string, unknown>): string {
  const list = arr<ReportedFinding>(d.findings);
  const total = num(d.findings_total) ?? list.length;
  const shown = list.slice(0, 3).map((f) => `${f.id}${f.severity ? ` (${f.severity})` : ""}: ${clip(str(f.summary), 140)}`);
  if (total > shown.length) shown.push(`${total - shown.length} more`);
  return shown.join("; ") || "see the report";
}

/** Workflow progress lines for the Lead to post in the chat; low-level events give none. */
export function renderProgress(events: LrEvent[]): string[] {
  const out: string[] = [];
  events.forEach((e, i) => {
    const line = progressLine(e, i, events);
    if (line) out.push(line);
  });
  return out;
}

function progressLine(e: LrEvent, i: number, all: LrEvent[]): string | null {
  const d = e.data;
  const phase = e.phase ?? "";
  switch (e.type) {
    case "phase.started":
      return `[PHASE START] ${phase} "${str(d.title)}"`;
    case "preflight.passed":
      return `[PREFLIGHT COMPLETE] ${phase} checks passed${d.risk ? ` (risk ${str(d.risk)})` : ""}.`;
    case "stage.entered":
      return stageLine(e);
    case "run.issued":
      return issuedLine(e);
    case "mode.auto_delegate":
      return `[NOTE] ${roleName(e.role)} is configured as Direct on ${e.agent}, but the Lead runs in ${str(d.host)}; it runs through ${e.agent}-delegate instead.`;
    case "result.accepted":
      return acceptedLine(e);
    case "result.rejected":
      return block("[ISSUE]", `The ${roleName(e.role)} result of task ${e.run_id} was rejected.`, `Reason: ${clip(arr<string>(d.errors).join("; "))}`, `Action: ${followUp(e, all.slice(i + 1), "None (side runs are advisory).")}`);
    case "run.failed":
    case "run.interrupted":
      return block(
        "[ISSUE]",
        `Task ${e.run_id} (${roleName(e.role)} on ${e.agent}) ${e.type === "run.interrupted" ? "was interrupted" : "failed"}.`,
        `Reason: ${str(d.kind)}${lastLine(str(d.detail)) ? `: ${clip(lastLine(str(d.detail)), 160)}` : ""}`,
        `Action: ${followUp(e, all.slice(i + 1), /-(worker|reviewer-adhoc)-/.test(e.run_id ?? "") ? "None (side run)." : "Retry with the same agent.")}`,
      );
    case "run.reask":
      return d.mismatches ? block("[ISSUE]", "The handover file lists do not match git.", "Action: Asking the Implementer to correct the lists (no file changes).") : null;
    case "expansion.executed": {
      const r = (d.request ?? {}) as Record<string, unknown>;
      return `[EXPANSION] Added ${str(r.kind)} ${str(r.id)} to the ${roleName(e.role)} sources.`;
    }
    case "context.over_budget":
      return `[WARNING] The ${roleName(e.role)} packet is ${str(d.kb)} KB, above the ${str(d.budget)} KB budget of ${e.agent}. Continuing with the full packet.`;
    case "readonly.violation":
      return `[ISSUE] The read-only ${roleName(e.role)} run ${e.run_id} changed files: ${arr<string>(d.files).join(", ") || "(reported by the relay)"}.`;
    case "gates.run":
      return gatesLine(e, i, all);
    case "checkpoint.committed":
      return `[CHECKPOINT] Committed "${str(d.label)}" (${str(d.commit).slice(0, 10)}).`;
    case "assignment.changed":
      return `[FALLBACK] ${roleName(e.role)}: ${str(d.from) || "none"} replaced by ${str(d.to)} (${str(d.reason).replace(/_/g, " ")}).`;
    case "quota.wait":
      return `[WAITING] ${roleName(e.role)} on ${e.agent}: ${str(d.reason)}. Looprch checks again at ${str(d.until)}.`;
    case "ratelimit.detected":
      return `[WAITING] ${e.agent} reported a rate limit. Looprch waits for the reset or switches to a fallback.`;
    case "question.asked":
      return `[DECISION NEEDED] ${QUESTIONS[str(d.kind) as QuestionKind] ?? "Looprch needs your answer."}`;
    case "question.answered":
      return `[DECISION] You chose "${str(d.option)}"${d.text ? `: ${clip(str(d.text))}` : ""}.`;
    case "paused":
      return "[PAUSED] Looprch paused at your request.";
    case "resumed": {
      const cleared = arr<string>(d.cleared);
      return `[RESUMED] ${cleared.length ? `Cleared: ${cleared.join(", ")}.` : "Nothing to clear."}${d.note ? ` Note for the next role: ${clip(str(d.note))}` : ""}`;
    }
    case "blocked":
      return block("[BLOCKED]", `Reason (${str(d.code)}): ${str(d.reason)}`, ...(d.hint ? [`Fix: ${str(d.hint)}`] : []));
    case "review.skipped":
      return block("[REVIEW SKIPPED]", `The review limit (${str(d.limit)}) is reached; the final repair goes to handover without another review.`, `Open findings recorded in the handover: ${arr<string>(d.findings).join(", ") || "none"}`);
    case "handover.accepted":
      return "[HANDOVER COMPLETE] Handover accepted; its file lists match git.";
    case "phase.closed":
      return `[PHASE COMPLETE] ${phase} closed and merged (tag ${str(d.tag)}).`;
    case "project.done":
      return "[PROJECT COMPLETE] Final report: .looprch/FINAL_REPORT.md";
    case "spec.changed":
      return "[ISSUE] The SEV3 package changed since it was accepted.";
    case "protocol.mismatch":
      return `[PAUSED] This phase started with protocol ${str(d.phase_protocol)}; this Looprch uses protocol ${str(d.core_protocol)}. Run looprch resume to continue.`;
    case "lock.stale_recovered":
      return "[WARNING] Recovered a stale project lock left by a stopped Looprch process.";
    case "warning":
      return `[WARNING] ${str(d.message)}`;
    case "init.discovered":
    case "init.gates_acknowledged":
    case "config.changed":
    case "preflight.failed":
    case "run.dispatched":
    case "run.completed":
    case "gate.result":
    case "quota.checked":
    case "quota.fallback":
    case "todo.ticked":
    case "phase.merged":
      return null;
    default: {
      const never: never = e.type;
      return `[EVENT] ${String(never)}`;
    }
  }
}

/** What Looprch does after a failed or rejected run, read from the events that follow it. */
function followUp(e: LrEvent, rest: LrEvent[], otherwise: string): string {
  for (const x of rest) {
    if (x.type === "blocked") return "Looprch stopped; see [BLOCKED] below.";
    if (x.type === "assignment.changed" && x.role === e.role) return `Switching the ${roleName(e.role)} to ${str(x.data.to)}.`;
    if (x.type === "ratelimit.detected" && x.run_id === e.run_id) return "Waiting for the rate limit to reset, or switching to a fallback.";
    if (x.type === "run.reask" && x.run_id === e.run_id) return `Asking the ${roleName(e.role)} once more for a valid report.`;
  }
  return otherwise;
}

function stageLine(e: LrEvent): string | null {
  const phase = e.phase ?? "";
  const round = num(e.data.round) ?? 0;
  const stage = e.stage as Stage;
  switch (stage) {
    case "preflight":
    case "plan_approval":
      return null;
    case "planning":
      return `[PLANNING START] ${phase} planning started.`;
    case "debating":
      return "[DEBATE START] Plan sent for debate.";
    case "synthesizing":
      return "[PLAN UPDATE START] The Planner is updating the plan.";
    case "implementing":
      return `[IMPLEMENTATION START] ${phase} implementation started.`;
    case "testing":
      return `[TESTING START] ${phase} testing started${round ? ` (repair round ${round})` : ""}.`;
    case "gating":
      return "[GATES START] Looprch runs the declared gates.";
    case "reviewing":
      return `[REVIEW START] ${phase} review started.`;
    case "repairing":
      return `[REPAIR START] Repair round ${round} started.`;
    case "handover":
      return "[HANDOVER START] The Implementer writes the handover.";
    case "closing":
      return "[CLOSING START] Ticking todo.md, then commit, merge and tag.";
    default: {
      const never: never = stage;
      return `[STAGE] ${String(never)}`;
    }
  }
}

function issuedLine(e: LrEvent): string {
  const d = e.data;
  const attempt = num(d.attempt) ?? 1;
  const why = MODE_REASONS[str(d.mode_reason) as ModeReason];
  const details = [`${e.agent}${d.model ? `/${str(d.model)}` : ""}`, str(d.mode), ...(attempt > 1 ? [`attempt ${attempt}`] : []), ...(why ? [why] : [])];
  return `${attempt > 1 ? "[RETRY]" : "[TASK START]"} ${e.run_id}: ${roleName(e.role)} (${str(d.task)}) on ${details.filter(Boolean).join(" · ")}`;
}

function acceptedLine(e: LrEvent): string | null {
  const d = e.data;
  const decision = str(d.decision);
  const phase = e.phase ?? "";
  const by = `${roleName(e.role)} on ${e.agent}`;
  const total = num(d.findings_total) ?? arr(d.findings).length;
  if (decision === "needs_expansion") return `[MORE SOURCES] The ${by} asked for more source material; Looprch adds it and runs the ${roleName(e.role)} again.`;
  if (!d.task) return `[TASK COMPLETE] ${e.run_id}: ${by} returned ${decision}.`;
  const task = str(d.task) as Task;
  switch (task) {
    case "planning":
      return `[PLANNING COMPLETE] Initial plan completed by the ${by}: .looprch/phases/${phase}/plan.md`;
    case "debate":
      return decision === "findings"
        ? block("[DEBATE COMPLETE]", `Result: Changes recommended (${plural(total, "finding")}${severities(d.severities)}).`, `Summary: ${findingsText(d)}`)
        : block("[DEBATE COMPLETE]", "Result: No changes recommended. Original plan accepted.");
    case "synthesis":
      return `[PLAN UPDATED] The Planner updated the plan after the debate: .looprch/phases/${phase}/plan.md`;
    case "revise":
      return `[PLAN UPDATED] The Planner revised the plan as you asked: .looprch/phases/${phase}/plan.md`;
    case "context_answer":
      return "[CONTEXT ANSWERED] The Planner answered the Implementer's context request.";
    case "implementation":
    case "repair":
      if (decision === "needs_context") return "[CONTEXT NEEDED] The Implementer asked the Planner for missing context.";
      return `[${task === "implementation" ? "IMPLEMENTATION" : "REPAIR"} COMPLETE] The ${by} finished; ${plural(num(d.touched) ?? 0, "file")} touched.`;
    case "testing":
      return decision === "pass" ? `[TESTING COMPLETE] Tester verdict: pass (${e.agent}).` : block("[TESTING COMPLETE]", `Tester verdict: fail (${plural(total, "failure")}).`, `Failures: ${findingsText(d)}`);
    case "review":
      return decision === "approve"
        ? `[REVIEW COMPLETE] Approved by the ${by}.`
        : block("[REVIEW COMPLETE]", `Result: Changes requested (${plural(total, "finding")}${severities(d.severities)}).`, `Findings: ${findingsText(d)}`);
    case "handover":
      return null;
    case "adhoc_review":
      return `[SIDE REVIEW COMPLETE] ${e.run_id}: ${decision.replace(/_/g, " ")} (advisory).`;
    case "worker":
      return `[WORKER COMPLETE] ${e.run_id} answered (advisory).`;
    default: {
      const never: never = task;
      return `[TASK COMPLETE] ${e.run_id}: ${String(never)} ${decision}.`;
    }
  }
}

function gatesLine(e: LrEvent, i: number, all: LrEvent[]): string {
  const results: LrEvent[] = [];
  for (let j = i - 1; j >= 0 && all[j]!.type === "gate.result"; j--) results.unshift(all[j]!);
  if (!results.length) return `[GATES COMPLETE] ${e.data.all_passed ? "All gates passed." : "Some gates failed."}`;
  const failed = results.filter((r) => r.data.ok !== true);
  if (!failed.length) return `[GATES COMPLETE] ${results.length === 1 ? "The gate passed." : `All ${results.length} gates passed.`}`;
  return block("[GATES COMPLETE]", `Result: ${results.length - failed.length}/${results.length} gates passed.`, `Failed: ${failed.map((f) => `${str(f.data.gate_id)}${f.data.reason ? ` (${clip(str(f.data.reason), 80)})` : ""}`).join("; ")}`);
}
