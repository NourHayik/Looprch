import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, PROTOCOL, READ_ONLY_ROLES, type Role } from "./constants.js";
import type { AgentId, Approval, Assignment, Config } from "./config.js";
import { debateRounds, loadConfig, reviewRounds } from "./config.js";
import { addEntries, applyDispositions, applyVerdicts, closeEntries, entryLine, ledgerSummary, loadLedger, openEntries, saveLedger, SERIOUS, type DebateEntry, type DebateLedger } from "./debate.js";
import { readRelayUsage } from "../delegate/usage.js";
import type { Action, RunRoleAction } from "./actions.js";
import { assembleBrief, REPORT_FILE_TASKS, writeBrief, type ImplementerInfo, type Task } from "./briefs.js";
import { now, nowIso, reviewTimeout } from "./clock.js";
import { LrError, errorMessage } from "./errors.js";
import { ensureDir, writeFileAtomic } from "./fsx.js";
import { appendEvent, type EventInput } from "./journal.js";
import { resolveMode, type ModeReason } from "./mode.js";
import { projectPaths } from "./paths.js";
import { preflightChecks } from "./preflight.js";
import { extractResultBlock, validateResult, type ExpansionRequest, type RoleResult } from "./results.js";
import { loadRun, relayOutDir, saveRun, type RunRecord, type RunStatus } from "./runs.js";
import { loadState, markPhaseStart, newCurrent, QUESTION_KINDS, saveState, type AssignmentChange, type Delta, type Finding, type QuestionKind, type Scope, type Stage, type State } from "./state.js";
import { incomingDeferrals, loadPlan, newPlan, normalizeSessions, savePlan, unmappedRequirements, type Plan } from "./plan.js";
import { adapterFor } from "../agents/index.js";
import { readRelayResult } from "../delegate/result.js";
import { forgetSession, recordSession, resumableSession, sessionKey } from "../delegate/sessions.js";
import { pidAlive } from "./lock.js";
import { decide, looksRateLimited, providerVerdict } from "../quota/policy.js";
import { readQuota } from "../quota/quotalens.js";
import { readManifest, relatedPhaseIds, type Manifest, type PhaseDef } from "../sev3/manifest.js";
import { buildPacket, PACKET_ROLE, type Packet } from "../sev3/packets.js";
import { verifyPackage } from "../sev3/fingerprint.js";
import { isTicked, tick } from "../sev3/todo.js";
import { commitAll, currentBranch, dirtyFiles, gitOk, hasCommits, head } from "../git/git.js";
import { commitBaseline, ensureRepo, requireIdentity } from "../git/baseline.js";
import { closePhase, phaseBranch, startPhaseBranch } from "../git/phase.js";
import { changedBetween, diffNameStatus, snapshotTree } from "../git/snapshot.js";
import { loadGates, type GatesOutcome } from "../gates/runner.js";
import type { E2eOutcome } from "../gates/e2e.js";

export interface Engine {
  root: string;
  cfg: Config;
  st: State;
  manifest: Manifest;
  host: AgentId | null;
  events: EventInput[];
}

export function loadEngine(root: string, host: AgentId | null): Engine {
  return { root, cfg: loadConfig(root), st: loadState(root), manifest: readManifest(root), host, events: [] };
}

export function persist(e: Engine): void {
  saveState(e.root, e.st);
  for (const ev of e.events) appendEvent(e.root, ev);
  e.events = [];
}

function severityCounts(list: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of list) if (f.severity) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

function ev(e: Engine, input: EventInput): void {
  const cur = e.st.current;
  e.events.push({ phase: cur?.phase ?? null, stage: cur?.stage ?? null, ...input });
}

function base(e: Engine, summary: string) {
  const cur = e.st.current;
  return { protocol: PROTOCOL, phase: cur?.phase ?? null, stage: cur?.stage ?? null, round: cur?.round ?? 0, summary };
}

function phaseDef(e: Engine, id: string): PhaseDef {
  const p = e.manifest.phases.find((x) => x.id === id);
  if (!p) throw new LrError("unknown_phase", `Phase ${id} is not in the manifest`);
  return p;
}

function cur(e: Engine) {
  const c = e.st.current;
  if (!c) throw new LrError("no_phase", "No phase is in progress");
  return c;
}

export function block(e: Engine, code: string, reason: string, hint: string, details: unknown = null): Action {
  e.st.flags.blocked = { code, reason, details, hint, at: nowIso() };
  ev(e, { type: "blocked", data: { code, reason, hint } });
  return { ...base(e, reason), action: "blocked", code, reason, details, hint, durable: true };
}

function blockedFromFlag(e: Engine): Action {
  const b = e.st.flags.blocked!;
  return { ...base(e, b.reason), action: "blocked", code: b.code, reason: b.reason, details: b.details, hint: b.hint, durable: true };
}

function ask(e: Engine, kind: QuestionKind, id: string, question: string, options: { id: string; label: string }[], context: Record<string, unknown> = {}): Action {
  e.st.pending_question = { id, kind, question, options, context };
  ev(e, { type: "question.asked", data: { id, kind } });
  return askAction(e);
}

function askAction(e: Engine): Action {
  const q = e.st.pending_question!;
  return { ...base(e, q.question), action: "ask_user", question_id: q.id, kind: q.kind, question: q.question, options: q.options, command_template: ["looprch", "answer", q.id, "<option_id>"] };
}

function transition(e: Engine, stage: Stage): void {
  const c = cur(e);
  c.stage = stage;
  c.stage_entered_at = nowIso();
  ev(e, { type: "stage.entered", stage, data: { round: c.round } });
}

function approvalApplies(a: Approval, phase: PhaseDef): boolean {
  return a === "always" || (a === "high-risk" && (phase.risk === "high" || phase.risk === "critical"));
}

function rel(e: Engine, abs: string): string {
  return abs.startsWith(e.root + "/") ? abs.slice(e.root.length + 1) : abs;
}

function phaseFile(e: Engine, name: string): string {
  return join(projectPaths(e.root).phase(cur(e).phase), name);
}

/** Write a stage artifact, keeping the previous version as <name>.r<n>.md. */
function writeArtifact(e: Engine, name: string, text: string): string {
  const path = phaseFile(e, name);
  if (existsSync(path)) {
    const stem = name.replace(/\.md$/, "");
    let n = 0;
    while (existsSync(phaseFile(e, `${stem}.r${n}.md`))) n++;
    copyFileSync(path, phaseFile(e, `${stem}.r${n}.md`));
  }
  writeFileAtomic(path, `${text.trim()}\n`);
  return rel(e, path);
}

function existingInputs(e: Engine, names: [string, string][]): { path: string; why: string }[] {
  return names.filter(([n]) => existsSync(phaseFile(e, n))).map(([n, why]) => ({ path: rel(e, phaseFile(e, n)), why }));
}

function closedHandovers(e: Engine, phase: PhaseDef): { path: string; why: string }[] {
  return relatedPhaseIds(e.manifest, phase)
    .filter((id) => e.st.phases[id]?.status === "closed")
    .map((id) => join(projectPaths(e.root).phase(id), "handover.md"))
    .filter((p) => existsSync(p))
    .map((p) => ({ path: rel(e, p), why: "CLOSED handover of a related phase (verified evidence of what exists)" }));
}

// ---------------------------------------------------------------------------------------------
// next

export function next(e: Engine, scope?: Scope): Action {
  if (scope) e.st.scope = scope;
  for (let i = 0; i < 40; i++) {
    const a = step(e);
    if (a) return a;
  }
  throw new LrError("internal", "The lifecycle did not reach an action after 40 internal steps");
}

function step(e: Engine): Action | null {
  const st = e.st;
  const c = st.current;
  if (c && st.protocol !== PROTOCOL && !st.flags.paused) {
    st.flags.paused = { reason: `protocol_changed: this phase started with protocol ${st.protocol}; this Looprch uses protocol ${PROTOCOL}. Run looprch resume to continue with the new protocol${st.protocol < 5 ? " (the phase restarts at planning; its old plan files move to v07/)" : ""}.`, at: nowIso() };
    ev(e, { type: "protocol.mismatch", data: { phase_protocol: st.protocol, core_protocol: PROTOCOL } });
  }
  if (st.flags.paused?.reason.startsWith("protocol_changed")) return { ...base(e, st.flags.paused.reason), action: "paused", reason: st.flags.paused.reason };
  if (st.flags.blocked) return blockedFromFlag(e);
  if (st.pending_question) return askAction(e);
  if (c && c.stage !== "preflight") {
    const g = headGuard(e);
    if (g) return g;
  }
  if (c?.active_run) return handleActiveRun(e);
  if (st.flags.pause_requested) {
    st.flags.pause_requested = false;
    st.flags.paused = { reason: "paused by the user", at: nowIso() };
    ev(e, { type: "paused", data: {} });
  }
  if (st.flags.paused) return { ...base(e, st.flags.paused.reason), action: "paused", reason: st.flags.paused.reason };
  if (st.flags.waiting) {
    const w = st.flags.waiting;
    if (now() < Date.parse(w.until)) return { ...base(e, `Waiting until ${w.until}: ${w.reason}`), action: "wait", until: w.until, reason: w.reason, command: ["looprch", "wait", "--max", "10m"] };
    if (w.reason.startsWith("rate limit") && w.agent) clearRateLimit(e, w.agent as AgentId);
    st.flags.waiting = null;
    return null;
  }
  if (st.pending_checkpoint) return { ...base(e, `Commit a checkpoint: ${st.pending_checkpoint.label}`), action: "checkpoint", label: st.pending_checkpoint.label, command: ["looprch", "checkpoint"] };
  if (!c) return selectPhase(e);
  const phase = phaseDef(e, c.phase);
  switch (c.stage) {
    case "preflight":
      return runPreflight(e, phase);
    case "planning":
      return issueRun(e, "planner", "planning");
    case "debating": {
      const ledger = loadLedger(e.root, c.phase);
      if (ledger.rounds > 0 && ledger.rounds >= debateRounds(e.cfg) && openEntries(ledger).length) return debateLimitReached(e, ledger);
      return issueRun(e, "plan_debater", ledger.rounds === 0 ? "debate" : "rebuttal");
    }
    case "synthesizing":
      return issueRun(e, "planner", c.deltas.planner?.kind === "revise" ? "revise" : "synthesis");
    case "plan_approval": {
      if (approvalApplies(e.cfg.approvals.plan, phase)) {
        const qid = `approve_plan-${c.phase}-r${c.round}-${readdirSafe(projectPaths(e.root).phase(c.phase)).filter((f) => /^plan\.r\d+\.md$/.test(f)).length}`;
        const ans = st.answers[qid];
        if (!ans) return ask(e, "approve_plan", qid, `Approve the plan for ${c.phase} "${c.title}"? Read .looprch/phases/${c.phase}/plan.md first.`, [{ id: "approve", label: "Approve and implement" }, { id: "revise", label: "Ask the Planner to revise (add --text)" }]);
      }
      startImplementation(e);
      return null;
    }
    case "implementing":
    case "repairing":
      if (c.context_request) return issueRun(e, "planner", "context_answer");
      return issueRun(e, "implementer", c.stage === "implementing" ? "implementation" : "repair");
    case "testing":
      return issueRun(e, "tester", "testing");
    case "gating":
      return { ...base(e, `Run the ${phase.gates.length} declared gate(s) of ${c.phase}`), action: "run_gates", command: ["looprch", "gates", "run", "--phase", c.phase] };
    case "reviewing": {
      if (c.final_review_pending) return finalReviewQuestion(e);
      const snap = snapshotTree(e.root);
      if (snap !== c.snapshots.gates) {
        ev(e, { type: "warning", data: { message: "Working tree changed after the gates ran; re-running gates" } });
        transition(e, "gating");
        return null;
      }
      if (reviewsExhausted(e)) {
        afterGatesPassed(e);
        return null;
      }
      return issueRun(e, "reviewer", "review");
    }
    case "handover":
      return issueRun(e, "implementer", "handover");
    case "closing":
      return runClosing(e, phase);
    default: {
      const never: never = c.stage;
      throw new LrError("internal", `Unknown stage ${String(never)}`);
    }
  }
}

function readdirSafe(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

function headGuard(e: Engine): Action | null {
  const c = cur(e);
  if (!c.last_commit) return null;
  const br = currentBranch(e.root);
  if (e.cfg.git.phase_branches && c.branch && br !== c.branch)
    return block(e, "head_mismatch", `You are on ${br ?? "a detached HEAD"}, but ${c.phase} runs on ${c.branch}`, `Switch back with: git switch ${c.branch}  (then run looprch resume)`);
  const h = head(e.root);
  if (h !== c.last_commit) {
    const parent = gitOk(e.root, ["rev-parse", "--verify", "-q", `${h}^`]);
    const msg = gitOk(e.root, ["log", "-1", "--format=%s", h ?? "HEAD"]);
    if (parent === c.last_commit && msg.startsWith(`looprch(${c.phase}):`)) {
      c.last_commit = h;
      return null;
    }
    return block(e, "head_mismatch", `HEAD moved to ${h?.slice(0, 10)} with commits not made by Looprch (expected ${c.last_commit.slice(0, 10)})`, "Agents and users must not commit during a phase. Undo the extra commits yourself (Looprch never resets), then run looprch resume.");
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// phase selection, preflight

function selectPhase(e: Engine): Action | null {
  const st = e.st;
  const closed = (id: string) => st.phases[id]?.status === "closed";
  const remaining = e.manifest.phases.filter((p) => !closed(p.id));
  if (remaining.length === 0) {
    if (isTicked(e.root, "PROJECT:production-readiness") && st.project.status === "done")
      return { ...base(e, "The project is complete"), action: "project_done", report: ".looprch/FINAL_REPORT.md" };
    if (st.scope === "finish") return finishProject(e);
    return { ...base(e, "All phases are closed. Run /lr-finish for the final project closure."), action: "stop_before_closure", closure_phase: null };
  }
  const eligible = remaining.find((p) => (p.requires ?? []).every(closed));
  if (!eligible) return block(e, "config_invalid", "No eligible phase: prerequisites are not closed", "Check phases/manifest.json requires[]");
  if (eligible.kind === "closure" && st.scope !== "finish")
    return { ...base(e, `Next is the closure phase ${eligible.id}; run /lr-finish to execute it`), action: "stop_before_closure", closure_phase: eligible.id };
  if (st.scope === "finish" && eligible.kind !== "closure") {
    const reason = `${remaining.filter((p) => p.kind !== "closure").length} implementation phase(s) remain before the closure phase`;
    return { ...base(e, reason), action: "blocked", code: "phases_remaining", reason, details: null, hint: "Run /lr-auto (or /lr-phase) first", durable: false };
  }
  st.current = newCurrent(eligible.id, eligible.title, nowIso());
  markPhaseStart(st);
  st.phases[eligible.id] = { status: "in_progress", started_at: nowIso(), closed_at: null, merge_commit: null, tag: null, rounds_used: 0, implementers: [] };
  ev(e, { type: "phase.started", phase: eligible.id, stage: "preflight", data: { title: eligible.title } });
  return null;
}

function runPreflight(e: Engine, phase: PhaseDef): Action | null {
  const c = cur(e);
  const st = e.st;
  const t0 = Date.now();
  const r = preflightChecks(e.root, e.cfg, st, e.host);
  if (r.ok === "ask_gates") {
    const qid = `ack_gates-${r.manifest_sha256.slice(0, 16)}`;
    if (st.answers[qid] !== "acknowledge") {
      const cmds = phaseCommands(e.manifest);
      return ask(e, "ack_gates", qid, `The SEV3 gates will run these commands on this machine: ${cmds}. Acknowledge them for manifest ${r.manifest_sha256.slice(0, 12)}…?`, [{ id: "acknowledge", label: "Acknowledge and continue" }, { id: "stop", label: "Stop" }], { manifest_sha256: r.manifest_sha256 });
    }
    return null;
  }
  if (r.ok === false) {
    ev(e, { type: "preflight.failed", data: { code: r.code } });
    return block(e, r.code, r.reason, r.hint, r.details ?? null);
  }
  const first = !st.git.baseline_commit;
  ensureRepo(e.root);
  try {
    requireIdentity(e.root);
  } catch (err) {
    return block(e, "no_git_identity", errorMessage(err), (err as LrError).hint ?? "");
  }
  const dirty = dirtyFiles(e.root);
  if (first) {
    if (!hasCommits(e.root) || dirty.length) {
      const qid = `commit_baseline-${c.phase}`;
      const ans = st.answers[qid];
      if (!ans) {
        const all = dirtyFiles(e.root, false);
        const secret = all.filter((p) => /(^|\/)\.env(\..*)?$|\.pem$|(^|\/)id_[^/]*$|\.key$/.test(p));
        return ask(e, "commit_baseline", qid, `Before the first phase Looprch needs a clean git baseline. Commit these ${all.length} file(s) as "looprch: baseline"?${secret.length ? ` WARNING, secret-like files: ${secret.join(", ")}` : ""}`, [{ id: "commit_baseline", label: "Commit the baseline" }, { id: "stop", label: "Stop (I will commit myself)" }], { files: all.slice(0, 200), secret_like: secret });
      }
      if (ans === "stop") return block(e, "dirty_tree", "A clean baseline is required before the first phase", "Commit or remove the files yourself, then run looprch resume");
      try {
        commitBaseline(e.root);
      } catch (err) {
        return block(e, (err as LrError).code ?? "hook_failed", errorMessage(err), (err as LrError).hint ?? "");
      }
    }
    st.git.base_branch = currentBranch(e.root);
    st.git.baseline_commit = head(e.root);
  } else {
    if (dirty.length) return block(e, "dirty_tree", `The working tree has ${dirty.length} uncommitted change(s): ${dirty.slice(0, 8).join(", ")}`, "Commit or remove them on the base branch, then run looprch resume", { files: dirty });
    const br = currentBranch(e.root);
    if (st.git.base_branch && br !== st.git.base_branch && br !== phaseBranch(c.phase))
      return block(e, "head_mismatch", `Phases start from ${st.git.base_branch}, but you are on ${br ?? "a detached HEAD"}`, `git switch ${st.git.base_branch}, then run looprch resume`);
  }
  const baseBranch = st.git.base_branch ?? currentBranch(e.root) ?? "main";
  if (e.cfg.git.phase_branches) {
    c.phase_base = startPhaseBranch(e.root, c.phase, baseBranch);
    c.branch = phaseBranch(c.phase);
  } else {
    c.phase_base = head(e.root);
    c.branch = null;
  }
  c.last_commit = head(e.root);
  ev(e, { type: "preflight.passed", data: { ms: Date.now() - t0, timings: r.timings, phase_base: c.phase_base, risk: phase.risk } });
  transition(e, "planning");
  return null;
}

function phaseCommands(m: Manifest): string {
  const set = new Map<string, number>();
  for (const p of m.phases) for (const g of p.gates) set.set(g.command[0]!, (set.get(g.command[0]!) ?? 0) + 1);
  return [...set.entries()].map(([k, v]) => `${k} (${v})`).join(", ");
}

// ---------------------------------------------------------------------------------------------
// issuing runs

function providerKey(agent: AgentId): string {
  return adapterFor(agent).quotalensProvider ?? agent;
}

function clearRateLimit(e: Engine, agent: AgentId): void {
  const k = providerKey(agent);
  if (e.st.quota.exhausted[k]?.source === "rate_limit") delete e.st.quota.exhausted[k];
}

type QuotaChoice = { kind: "attempt" } | { kind: "wait"; until: string; reason: string } | { kind: "fallback"; reset: string | null; reason: string };

function quotaChoice(e: Engine, a: Assignment): QuotaChoice {
  const key = providerKey(a.agent);
  const mark = e.st.quota.exhausted[key];
  if (mark?.source === "rate_limit") return { kind: "fallback", reset: mark.reset, reason: `rate limit reported by ${a.agent}` };
  const provider = adapterFor(a.agent).quotalensProvider;
  if (!provider) return { kind: "attempt" };
  const q = readQuota();
  const verdict = providerVerdict(q.data, provider);
  const d = decide(verdict, now(), e.cfg.limits.quota_wait_minutes);
  if (verdict.kind === "exhausted") ev(e, { type: "quota.checked", agent: a.agent, data: { provider, verdict, decision: d } });
  if (d.kind === "attempt") return d;
  const limits = verdict.kind === "exhausted" ? verdict.limits.join(", ") : "";
  if (d.kind === "wait") return { kind: "wait", until: d.until, reason: `usage limit ${limits} of ${provider} resets at ${d.until}` };
  return { kind: "fallback", reset: d.reset, reason: `usage limit ${limits} of ${provider} resets ${d.reset ? `at ${d.reset}` : "at an unknown time"}` };
}

function recordAssignment(e: Engine, role: Role, from: Assignment | null, to: Assignment, reason: AssignmentChange["reason"], runId: string | null): void {
  const c = cur(e);
  e.st.assignments_history.push({ phase: c.phase, role, from: from ? strip(from) : null, to: strip(to), reason, run_id: runId, at: nowIso() });
  ev(e, { type: "assignment.changed", role, agent: to.agent, run_id: runId, data: { from: from ? `${from.agent}/${from.model}` : null, to: `${to.agent}/${to.model}`, reason } });
}

function strip(a: Assignment): Assignment {
  return { mode: a.mode, agent: a.agent, model: a.model, ...(a.effort ? { effort: a.effort } : {}) };
}

function assignments(e: Engine, role: Role): Assignment[] {
  const rc = e.cfg.roles[role];
  if (!rc) throw new LrError("config_invalid", `Role ${role} is not configured`, `Run: looprch config set-role ${role} --mode ... --agent ... --model ...`);
  return [rc, ...rc.fallbacks];
}

/** The Implementer the Planner writes the sessions for (the current assignment of this phase). */
function implementerInfo(e: Engine): ImplementerInfo | null {
  const rc = e.cfg.roles.implementer;
  if (!rc) return null;
  const list = [rc, ...rc.fallbacks];
  const a = list[Math.min(e.st.current?.assignment_index.implementer ?? 0, list.length - 1)]!;
  return { agent: a.agent, model: a.model, context_kb: a.context_kb ?? e.cfg.context_kb[a.agent] ?? null };
}

function runInputs(e: Engine, role: Role, task: Task, phase: PhaseDef): { path: string; why: string }[] {
  const c = cur(e);
  const list: [string, string][] = [];
  const plan: [string, string] = ["plan.md", "the approved plan (with addenda at its end, if any): concept, decisions and how to do each todo"];
  const planJson: [string, string] = ["plan.json", "the plan's todos, Implementer sessions, requirement map and deferrals"];
  switch (task) {
    case "planning":
      break;
    case "debate":
      list.push(["plan.md", "the plan to challenge"], planJson);
      break;
    case "rebuttal":
      list.push(["plan.md", "the revised plan"], planJson, ["debate.json", "the debate ledger: every item, the Planner's answer and your earlier verdicts"], ["debate.md", "your last debate report"]);
      break;
    case "synthesis":
      list.push(["plan.md", "your plan"], planJson, ["debate.md", "the latest Plan Debate report"], ["debate.json", "the debate ledger: the open items you answer"]);
      break;
    case "revise":
      list.push(["plan.md", "the current plan"], planJson, ["debate.json", "the debate ledger"]);
      break;
    case "context_answer":
      list.push(["plan.md", "the current plan"], planJson);
      break;
    case "implementation":
      list.push(plan);
      break;
    case "repair":
      list.push(plan, ["test-report.md", "latest test report"], ["gates.json", "machine evidence from Looprch's gate runs"]);
      if (c.repair_source === "review") list.push(["review.md", "review findings to address"]);
      break;
    case "testing":
      list.push(plan);
      if (c.round > 0) list.push(["gates.json", "earlier gate runs"]);
      if (c.repair_source === "review") list.push(["review.md", "review findings whose repairs you test"]);
      break;
    case "review":
      list.push(plan, ["test-report.md", "Tester report"], ["gates.json", "machine evidence (bound to the reviewed snapshot)"], ["changed-files.txt", "every file the phase changed (git diff --name-status against the phase base)"]);
      break;
    case "handover":
      list.push(plan, ["gates.json", "final gate runs"], ["test-report.md", "Tester report"], ["review.md", "Reviewer report"]);
      break;
    case "adhoc_review":
    case "worker":
      break;
    default: {
      const never: never = task;
      throw new LrError("internal", `unhandled task ${String(never)}`);
    }
  }
  const out = existingInputs(e, list);
  if (task === "planning" || task === "synthesis" || task === "revise") {
    const incoming = incomingDeferrals(e.root, e.manifest, e.st, c.phase);
    if (incoming.length) {
      const path = phaseFile(e, "incoming-deferrals.json");
      writeFileAtomic(path, `${JSON.stringify(incoming, null, 2)}\n`);
      out.push({ path: rel(e, path), why: `work that closed phases deferred to ${c.phase}; plan each item, or defer it again` });
    }
  }
  if (task === "testing" || task === "review") for (const p of c.repair_reports ?? []) out.push({ path: p, why: "Implementer repair report: how each finding was fixed" });
  if (task === "planning" || task === "implementation" || task === "review") out.push(...closedHandovers(e, phase));
  if (role === "tester" || role === "reviewer") {
    const gates = phase.gates.map((g) => `${g.id}: ${g.command.join(" ")} [${g.kind}${g.negative ? ", negative" : ""}, evidence ${g.evidence.format}]`).join("; ");
    out.push({ path: "phases/manifest.json", why: `declared gates of ${phase.id}: ${gates}` });
  }
  return out;
}

export function issueRun(e: Engine, role: Role, task: Task): Action | null {
  const c = cur(e);
  const st = e.st;
  const phase = phaseDef(e, c.phase);
  let list: Assignment[];
  try {
    list = assignments(e, role);
  } catch (err) {
    return block(e, "config_invalid", errorMessage(err), (err as LrError).hint ?? "");
  }
  let idx = Math.min(c.assignment_index[role] ?? 0, list.length - 1);
  const startIdx = idx;
  let chosen: Assignment;
  let modeReason: ModeReason = "configured";
  let effective: "direct" | "delegate";
  for (;;) {
    const a = list[idx]!;
    const m = resolveMode(e.root, a, e.host);
    if (!m.ok) return block(e, m.code, `${role}: ${m.reason}`, m.hint);
    const q = quotaChoice(e, a);
    if (q.kind === "attempt") {
      chosen = a;
      effective = m.mode;
      if (m.reason === "d05_auto_delegate") modeReason = "d05_auto_delegate";
      break;
    }
    if (q.kind === "fallback" && idx + 1 < list.length) {
      const reason = q.reason.startsWith("rate limit") ? "rate_limit_fallback" : "quota_fallback";
      recordAssignment(e, role, a, list[idx + 1]!, reason, null);
      ev(e, { type: "quota.fallback", role, agent: list[idx + 1]!.agent, data: { from: a.agent, reason: q.reason } });
      idx++;
      continue;
    }
    const isRate = q.reason.startsWith("rate limit");
    if (isRate) {
      st.quota.rate_limit_wait_started ??= nowIso();
      if (now() - Date.parse(st.quota.rate_limit_wait_started) > 4 * 3_600_000) {
        const qid = `rate_limit_long-${st.quota.rate_limit_wait_started}`;
        if (!st.answers[qid]) return ask(e, "rate_limit_long", qid, `${a.agent} has been rate-limited for over 4 hours. Keep waiting?`, [{ id: "keep_waiting", label: "Keep waiting (retry every 15 minutes)" }, { id: "pause", label: "Pause" }], { agent: a.agent });
      }
    }
    const until = q.kind === "wait" ? q.until : (q.reset ?? new Date(now() + 15 * 60_000).toISOString());
    st.flags.waiting = { until, reason: isRate ? `rate limit on ${a.agent}; retrying at ${until}` : q.reason, role, agent: a.agent };
    ev(e, { type: "quota.wait", role, agent: a.agent, data: { until, reason: q.reason } });
    return { ...base(e, `Waiting until ${until}: ${st.flags.waiting.reason}`), action: "wait", until, reason: st.flags.waiting.reason, command: ["looprch", "wait", "--max", "10m"] };
  }
  if (idx !== startIdx) c.assignment_index[role] = idx;
  if (idx > 0 && modeReason === "configured") {
    const last = [...st.assignments_history].reverse().find((h) => h.phase === c.phase && h.role === role);
    modeReason = last && last.reason !== "config" ? last.reason : "quota_fallback";
  }
  const prevAgent = c.last_agent[role];
  if ((role === "implementer" || role === "tester") && prevAgent && prevAgent !== chosen.agent && c.switch_checkpointed[role] !== chosen.agent) {
    c.switch_checkpointed[role] = chosen.agent;
    st.pending_checkpoint = { label: `agent switch (${role} ${prevAgent} -> ${chosen.agent})` };
    c.deltas[role] = { ...(c.deltas[role] ?? { text: "" }), kind: "switch", text: `You take over the ${role} role in this phase from ${prevAgent}. Read the diff since the phase base and the earlier final messages listed below before continuing.${c.deltas[role]?.text ? `\n\n${c.deltas[role]!.text}` : ""}`, findings: c.deltas[role]?.findings, paths: c.deltas[role]?.paths };
    return null;
  }
  let packet: Packet | null = null;
  if (PACKET_ROLE[role]) {
    try {
      packet = buildPacket(e.root, c.phase, role);
    } catch (err) {
      const code = (err as LrError).code === "spec_changed" ? "spec_changed" : "config_invalid";
      return block(e, code, errorMessage(err), (err as LrError).hint ?? "");
    }
  }
  const budget = chosen.context_kb ?? e.cfg.context_kb[chosen.agent] ?? null;
  if (packet && budget && packet.bytes / 1024 > budget) {
    const key = `${c.phase}/${role}/${chosen.agent}`;
    if (!c.context_ok.includes(key)) {
      const larger = list.findIndex((x, j) => j > idx && (x.context_kb ?? e.cfg.context_kb[x.agent] ?? 0) > budget);
      if (larger >= 0) {
        const qid = `context_over_budget-${key}`;
        return ask(e, "context_over_budget", qid, `The ${role} packet is ${Math.ceil(packet.bytes / 1024)} KB, above the ${budget} KB budget of ${chosen.agent}/${chosen.model}. The packet is never truncated. Continue, or use fallback ${list[larger]!.agent}/${list[larger]!.model}?`, [{ id: "continue", label: `Continue with ${chosen.agent}` }, { id: `use_fallback_${larger}`, label: `Use ${list[larger]!.agent}` }], { role, key, fallback: larger });
      }
      c.context_ok.push(key);
      ev(e, { type: "context.over_budget", role, agent: chosen.agent, data: { kb: Math.ceil(packet.bytes / 1024), budget } });
    }
  }
  const key = sessionKey(c.phase, role, chosen.agent);
  const sessionId = resumableSession(st, key);
  const seq = (c.run_seq[role] ?? 0) + 1;
  c.run_seq[role] = seq;
  const runId = `${c.phase}-${role}-${seq}`;
  const attempt = (c.attempts[role] ?? 0) + 1;
  if (task === "review") writeChangedFiles(e);
  const inputs = runInputs(e, role, task, phase);
  const before = snapshotTree(e.root);
  const own = c.deltas[role] ?? null;
  const delta = task === "implementation" ? sessionDelta(e, own) : (own ?? (task === "review" ? reviewTargetsDelta(e) : null));
  if (delta?.kind === "switch" && c.phase_base) {
    const diffPath = join(projectPaths(e.root).run(runId), "diff.patch");
    writeFileAtomic(diffPath, gitOk(e.root, ["diff", c.phase_base, "HEAD"]));
    inputs.push({ path: rel(e, diffPath), why: "diff of this phase since its base (work so far)" });
    for (const r of previousFinals(e, role)) inputs.push({ path: r, why: "an earlier final message for this role" });
  }
  const readOnly = READ_ONLY_ROLES.includes(role);
  const baseTimeout = chosen.timeout ?? e.cfg.roles[role]?.timeout ?? "60m";
  const ledger = task === "debate" || task === "rebuttal" || task === "synthesis" ? loadLedger(e.root, c.phase) : null;
  const debateRound = ledger ? { n: task === "synthesis" ? ledger.rounds : ledger.rounds + 1, of: debateRounds(e.cfg) } : undefined;
  const reviewN = task === "review" ? (c.review_changes ?? 0) + 1 : 0;
  const timeout = task === "review" ? reviewTimeout(baseTimeout, reviewN) : baseTimeout;
  const session = task === "implementation" && c.sessions?.length ? { n: (c.session_index ?? 0) + 1, of: c.sessions.length } : null;
  const brief = assembleBrief({
    root: e.root,
    runId,
    role,
    task,
    stage: c.stage,
    phase: c.phase,
    phaseTitle: c.title,
    phaseBase: c.phase_base,
    packet: packet ? { path: packet.path, bytes: packet.bytes } : null,
    phaseSource: phase.en,
    inputs,
    delta,
    userNote: c.user_note,
    resume: !!sessionId,
    gateIds: phase.gates.map((g) => g.id),
    readOnly,
    ...(role === "planner" || role === "plan_debater" ? { implementer: implementerInfo(e) } : {}),
    ...(debateRound ? { debateRound } : {}),
    ...(task === "review" ? { reviewRound: { n: reviewN, of: reviewCap(e), tree: c.snapshots.gates, prevTree: reviewN > 1 ? (c.reviewed_tree ?? null) : null, timeout } } : {}),
  });
  const briefPath = writeBrief(e.root, runId, brief);
  const inputBytes = [packet?.path, ...inputs.map((i) => i.path)].filter((p): p is string => !!p).reduce((s, p) => s + fileSize(join(e.root, p)), 0);
  c.user_note = null;
  const run: RunRecord = {
    run_id: runId,
    phase: c.phase,
    stage: c.stage,
    task,
    role,
    mode: chosen.mode,
    effective_mode: effective!,
    mode_reason: modeReason,
    agent: chosen.agent,
    model: chosen.model,
    effort: chosen.effort ?? null,
    timeout,
    session_in: sessionId,
    resume: !!sessionId,
    attempt,
    status: "issued",
    side: false,
    read_only: readOnly,
    packet: packet?.path ?? null,
    brief: briefPath,
    pid: null,
    relay_path: null,
    relay_sha256: null,
    argv: null,
    started_at: nowIso(),
    finished_at: null,
    git_before: before,
    git_after: null,
    touched_files: [],
    session_out: null,
    decision: null,
    brief_bytes: Buffer.byteLength(brief),
    input_bytes: inputBytes,
  };
  saveRun(e.root, run);
  st.runs_index[runId] = { role, status: "issued", attempt, side: false };
  c.active_run = runId;
  c.last_agent[role] = chosen.agent;
  ev(e, {
    type: "run.issued",
    role,
    agent: chosen.agent,
    run_id: runId,
    data: { task, mode: effective!, mode_reason: modeReason, model: chosen.model, session: sessionId, packet_bytes: packet?.bytes ?? null, brief_bytes: run.brief_bytes, input_bytes: inputBytes, attempt, timeout, ...(reviewN ? { review_round: reviewN, review_cap: reviewCap(e) } : {}), ...(debateRound ? { debate_round: debateRound.n, debate_cap: debateRound.of } : {}), ...(session ? { work_session: session.n, work_sessions: session.of } : {}) },
  });
  if (modeReason === "d05_auto_delegate") ev(e, { type: "mode.auto_delegate", role, agent: chosen.agent, run_id: runId, data: { host: e.host } });
  return runRoleAction(e, run);
}

function fileSize(abs: string): number {
  try {
    return statSync(abs).isFile() ? statSync(abs).size : 0;
  } catch {
    return 0;
  }
}

/** The Implementer's delta for one session: the todos to do, in order, on top of any earlier instruction. */
function sessionDelta(e: Engine, own: Delta | null): Delta {
  const c = cur(e);
  const sessions = c.sessions ?? [];
  const idx = c.session_index ?? 0;
  const ids = sessions[idx] ?? [];
  const todos = new Map((loadPlan(e.root, c.phase)?.todos ?? []).map((t) => [t.id, t]));
  const done = c.todos_done ?? [];
  const lines = ids.length
    ? [
        `Session ${idx + 1} of ${sessions.length}. Do these todos in order, the way plan.md describes each one${done.length ? ` (done in earlier sessions: ${done.join(", ")})` : ""}:`,
        ...ids.map((id) => {
          const t = todos.get(id);
          return `- ${id}: ${t?.title ?? "(see plan.md)"}${t?.section ? ` [${t.section}]` : ""}`;
        }),
        "",
        `Report the ids you finished in "todos_done".${sessions.length > 1 ? " The other sessions run separately." : ""}`,
      ]
    : ["Implement the whole plan in plan.md."];
  const text = lines.join("\n");
  return { ...(own ?? {}), kind: own?.kind ?? "notes", text: own?.text ? `${own.text}\n\n${text}` : text };
}

/** A first review also checks the plan debate items the Planner and the Plan Debater did not agree on. */
function reviewTargetsDelta(e: Engine): Delta | null {
  const c = cur(e);
  const contested = loadLedger(e.root, c.phase).entries.filter((x) => x.status === "contested");
  if (!contested.length || (c.review_changes ?? 0) > 0) return null;
  return {
    kind: "rereview",
    text: ["Plan debate items the Planner and the Plan Debater did not agree on. Check how the implementation handles each one, and report a finding where it is wrong:", ...contested.map((x) => `- ${entryLine(x)}`)].join("\n"),
  };
}

/** changed-files.txt for a review: what the phase changed against its base. */
function writeChangedFiles(e: Engine): void {
  const c = cur(e);
  if (!c.phase_base) return;
  const tree = c.snapshots.gates ?? snapshotTree(e.root);
  const d = diffNameStatus(e.root, c.phase_base, tree);
  const lines = [...d.added.map((p) => `A\t${p}`), ...d.modified.map((p) => `M\t${p}`), ...d.deleted.map((p) => `D\t${p}`), ...d.renamed.map((r) => `R\t${r.from}\t${r.to}`)];
  writeFileAtomic(phaseFile(e, "changed-files.txt"), `${lines.join("\n")}\n`);
}

function previousFinals(e: Engine, role: Role): string[] {
  const c = cur(e);
  const out: string[] = [];
  for (const [id, r] of Object.entries(e.st.runs_index)) {
    if (!id.startsWith(`${c.phase}-${role}-`) || r.side) continue;
    const p = join(projectPaths(e.root).run(id), "final.md");
    if (existsSync(p)) out.push(rel(e, p));
  }
  return out;
}

export function runRoleAction(e: Engine, run: RunRecord): RunRoleAction {
  const a = adapterFor(run.agent);
  const action: RunRoleAction = {
    ...base(e, `${run.role} (${run.task}) via ${run.agent} · ${run.effective_mode}${run.mode_reason === "d05_auto_delegate" ? ` (direct→delegate, host is ${e.host})` : ""}`),
    action: "run_role",
    run_id: run.run_id,
    role: run.role,
    task: run.task,
    mode: run.effective_mode,
    mode_reason: run.mode_reason,
    agent: run.agent,
    model: run.model,
    effort: run.effort,
    brief: run.brief,
    packet: run.packet,
    read_only: run.read_only,
    session: { id: run.session_in, resume: run.resume },
    attempt: run.attempt,
  };
  if (run.effective_mode === "delegate") action.command = ["looprch", "dispatch", run.run_id];
  else {
    action.subagent = `lr-${run.role}`;
    action.spawn_hint = a.direct?.spawnHint ?? "Spawn your native subagent with the brief.";
    action.record_command = ["looprch", "record", run.run_id, "--stdin"];
  }
  return action;
}

// ---------------------------------------------------------------------------------------------
// active runs, results, failures

function handleActiveRun(e: Engine): Action | null {
  const c = cur(e);
  const run = loadRun(e.root, c.active_run!);
  switch (run.status) {
    case "issued":
      if (run.effective_mode === "direct") {
        run.attempt++;
        saveRun(e.root, run);
      }
      return runRoleAction(e, run);
    case "running":
      if (run.pid && pidAlive(run.pid) && !existsSync(join(projectPaths(e.root).run(run.run_id), "exit.json")))
        return { ...base(e, `${run.role} is still running in ${run.agent} (run ${run.run_id})`), action: "await_run", run_id: run.run_id, poll_after_seconds: 30, command: ["looprch", "dispatch", "--wait", run.run_id] };
      finalizeRun(e, run);
      return null;
    default:
      c.active_run = null;
      return null;
  }
}

function readExit(e: Engine, runId: string): { code: number | null; signal: string | null } | null {
  const p = join(projectPaths(e.root).run(runId), "exit.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Turn a finished (or vanished) delegate run into an accepted result or a failure. Idempotent. */
export function finalizeRun(e: Engine, run: RunRecord): void {
  if (run.status !== "running") return;
  const sessionField = adapterFor(run.agent).delegate?.sessionField;
  let res;
  try {
    res = readRelayResult(join(relayOutDir(e.root, run.run_id), "result.json"), sessionField);
  } catch (err) {
    handleRunFailure(e, run, "failed", errorMessage(err));
    return;
  }
  const exit = readExit(e, run.run_id);
  if (!res) {
    const stderrPath = join(projectPaths(e.root).run(run.run_id), "relay.stderr");
    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").slice(-2000) : "";
    if (exit?.code === 2) handleRunFailure(e, run, "usage_error", stderr);
    else if (exit?.code === 127) handleRunFailure(e, run, "unavailable", stderr);
    else handleRunFailure(e, run, "interrupted", exit ? `relay exited ${exit.code ?? exit.signal} without a result` : "relay process disappeared without a result");
    return;
  }
  if (res.status === "completed") {
    acceptResult(e, run, res.finalMessage, res.sessionId, res.readOnlyViolation);
    return;
  }
  const text = `${res.error ?? ""}\n${res.stderrTail}\n${res.finalMessage}`;
  const detail = [res.error, res.stderrTail.slice(-500)].filter(Boolean).join("\n");
  if (looksRateLimited(text)) handleRunFailure(e, run, "rate_limited", detail);
  else handleRunFailure(e, run, res.status === "unavailable" ? "unavailable" : res.status, detail || res.rawStatus);
}

export function handleRunFailure(e: Engine, run: RunRecord, kind: Exclude<RunStatus, "issued" | "running" | "completed" | "rejected">, detail: string): void {
  run.status = kind;
  run.error = detail;
  run.finished_at = nowIso();
  recordTelemetry(e, run, "");
  saveRun(e.root, run);
  e.st.runs_index[run.run_id] = { ...(e.st.runs_index[run.run_id] ?? { role: run.role, attempt: run.attempt, side: run.side }), status: kind };
  ev(e, { type: kind === "interrupted" ? "run.interrupted" : "run.failed", role: run.role, agent: run.agent, run_id: run.run_id, data: { kind, detail: detail.slice(0, 500) } });
  if (run.side || !e.st.current) return;
  const c = cur(e);
  if (c.active_run === run.run_id) c.active_run = null;
  const role = run.role;
  const list = assignments(e, role);
  const idx = c.assignment_index[role] ?? 0;
  const fallback = (reason: AssignmentChange["reason"]) => {
    recordAssignment(e, role, list[idx]!, list[idx + 1]!, reason, run.run_id);
    c.assignment_index[role] = idx + 1;
    c.attempts[role] = 0;
  };
  switch (kind) {
    case "usage_error":
      block(e, "usage_error", `The ${run.agent} relay rejected Looprch's arguments (exit 2, no result). This is a Looprch bug.`, `See .looprch/runs/${run.run_id}/relay.stderr and report it`, { stderr: detail.slice(-1000), argv: run.argv });
      return;
    case "rate_limited":
      e.st.quota.exhausted[providerKey(run.agent)] = { reset: null, source: "rate_limit", since: nowIso() };
      e.st.quota.rate_limit_wait_started ??= nowIso();
      ev(e, { type: "ratelimit.detected", agent: run.agent, run_id: run.run_id, data: { detail: detail.slice(0, 300) } });
      return;
    case "unavailable":
      if (idx + 1 < list.length) fallback("unavailable_fallback");
      else block(e, "cli_missing", `${run.agent} is unavailable (CLI missing or not runnable)`, `Install ${adapterFor(run.agent).displayName} or assign ${role} to another agent`);
      return;
    case "failed":
    case "timeout":
    case "aborted":
    case "interrupted": {
      const attempts = (c.attempts[role] ?? 0) + 1;
      c.attempts[role] = attempts;
      if (run.resume) forgetSessionIfChanged(e, run);
      if (attempts < e.cfg.limits.run_attempts) {
        c.deltas[role] ??= { kind: "retry", text: `The previous attempt ended with status ${kind}. Continue the same task from the current state of the repository.` };
        return;
      }
      if (idx + 1 < list.length) fallback("run_failed_fallback");
      else block(e, "run_failed", `${role} failed ${attempts} time(s) on ${run.agent} (last: ${kind})`, `Inspect .looprch/runs/${run.run_id}/, then run looprch resume (or assign another agent)`, { detail: detail.slice(-1000) });
      return;
    }
    default: {
      const never: never = kind;
      throw new LrError("internal", `unhandled failure ${String(never)}`);
    }
  }
}

/** Wall time, result size and the relay's token usage of a finished run (measured, never estimated). */
function recordTelemetry(e: Engine, run: RunRecord, finalMessage: string): void {
  run.wall_ms = run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : undefined;
  run.result_bytes = Buffer.byteLength(finalMessage);
  run.usage = run.effective_mode === "delegate" ? readRelayUsage(relayOutDir(e.root, run.run_id)) : null;
}

function forgetSessionIfChanged(e: Engine, run: RunRecord): void {
  if (!run.session_out || run.session_out === run.session_in) return;
  forgetSession(e.st, sessionKey(run.phase ?? "", run.role, run.agent));
}

export interface AcceptOutcome {
  status: "accepted" | "reask" | "rejected";
  decision: string | null;
  artifact: string | null;
  errors: string[];
}

const TASK_DECISIONS: Record<Task, string[]> = {
  planning: ["plan_ready", "plan_final", "needs_expansion"],
  synthesis: ["plan_final", "plan_ready", "needs_expansion"],
  revise: ["plan_final", "plan_ready"],
  context_answer: ["context_answer"],
  debate: ["findings", "no_findings", "needs_expansion"],
  rebuttal: ["agree", "findings"],
  implementation: ["implemented", "needs_context"],
  repair: ["implemented", "needs_context"],
  handover: ["handover_ready"],
  testing: ["pass", "fail"],
  review: ["approve", "changes_requested"],
  adhoc_review: ["approve", "changes_requested"],
  worker: ["answered"],
};

/** The report file a role may write instead of putting its whole report into the final message. */
export function reportPath(e: Engine, runId: string): string {
  return join(projectPaths(e.root).run(runId), "report.md");
}

/**
 * The run's report file when it carries a result block, else the final message. The report file
 * is what `looprch check` validates, so a short final message never replaces it.
 */
function resultText(e: Engine, runId: string, finalMessage: string): string {
  const p = reportPath(e, runId);
  if (existsSync(p)) {
    const report = readFileSync(p, "utf8");
    if (extractResultBlock(report).ok) return report;
  }
  return finalMessage;
}

/** Can Looprch read this answer? The block, its shape, the task's decision and SEV3 expansion ids; nothing else. */
function readResult(e: Engine, run: RunRecord, text: string): { result: RoleResult | null; artifact: string; errors: string[] } {
  const ex = extractResultBlock(text);
  if (!ex.ok) return { result: null, artifact: ex.artifact, errors: [ex.error!] };
  const v = validateResult(run.role, ex.json, run.run_id);
  if (!v.ok) return { result: null, artifact: ex.artifact, errors: v.errors };
  if (!TASK_DECISIONS[run.task].includes(v.result.decision)) return { result: null, artifact: ex.artifact, errors: [`decision "${v.result.decision}" is not valid for this task; use one of ${TASK_DECISIONS[run.task].join(", ")}`] };
  const expansion = v.result.decision === "needs_expansion" && !run.side ? expansionProblems(e, v.result.expansion_requests ?? []) : [];
  if (expansion.length) return { result: null, artifact: ex.artifact, errors: expansion };
  return { result: v.result, artifact: ex.artifact, errors: [] };
}

/** The checks acceptResult applies to a role's report, without any side effect (`looprch check`). */
export function checkResult(e: Engine, run: RunRecord, text: string): { ok: boolean; decision: string | null; errors: string[] } {
  const r = readResult(e, run, text);
  return { ok: !!r.result, decision: r.result?.decision ?? null, errors: r.errors };
}

export function acceptResult(e: Engine, run: RunRecord, finalMessageIn: string, sessionId: string | null, readOnlyViolation = false): AcceptOutcome {
  const st = e.st;
  const finalMessage = resultText(e, run.run_id, finalMessageIn);
  run.finished_at = nowIso();
  run.session_out = sessionId;
  recordTelemetry(e, run, finalMessage);
  writeFileAtomic(join(projectPaths(e.root).run(run.run_id), "final.md"), finalMessage);
  if (!run.side && run.phase) {
    const key = sessionKey(run.phase, run.role, run.agent);
    const resumable = run.effective_mode === "delegate" ? !!adapterFor(run.agent).delegate?.resumable : !!sessionId;
    recordSession(st, key, sessionId, run.effective_mode, resumable, run.run_id);
  }
  clearRateLimit(e, run.agent);
  if (!Object.values(st.quota.exhausted).some((m) => m.source === "rate_limit")) st.quota.rate_limit_wait_started = null;
  const after = run.git_before ? snapshotTree(e.root) : null;
  run.git_after = after;
  run.touched_files = run.git_before && after ? changedBetween(e.root, run.git_before, after) : [];
  const finish = (status: RunStatus) => {
    run.status = status;
    saveRun(e.root, run);
    st.runs_index[run.run_id] = { role: run.role, status, attempt: run.attempt, side: run.side };
    if (!run.side && st.current?.active_run === run.run_id) st.current.active_run = null;
  };
  if (run.side && run.read_only && (readOnlyViolation || run.touched_files.length)) {
    finish("rejected");
    const errors = [`the advisory run changed files: ${run.touched_files.join(", ") || "(reported by the relay)"}; its answer is discarded (Looprch never reverts files)`];
    ev(e, { type: "result.rejected", role: run.role, agent: run.agent, run_id: run.run_id, data: { errors } });
    return { status: "rejected", decision: null, artifact: null, errors };
  }
  const { result, artifact, errors } = readResult(e, run, finalMessage);
  if (!result) {
    finish("rejected");
    ev(e, { type: "result.rejected", role: run.role, agent: run.agent, run_id: run.run_id, data: { errors } });
    if (run.side) return { status: "rejected", decision: null, artifact: null, errors };
    const c = cur(e);
    if (c.reask_count < 1) {
      c.reask_count++;
      const again =
        run.role === "planner" && REPORT_FILE_TASKS.has(run.task)
          ? "Write your complete report again, the markdown and exactly one valid looprch-result block at the end, to your report file (named in the self-check below), and run looprch check until it prints ok."
          : "Reply again with your complete report and exactly one valid looprch-result block at the end.";
      c.deltas[run.role] = { ...(c.deltas[run.role] ?? {}), kind: "reask", text: `Looprch could not read your previous result: ${errors.join("; ")}. ${again}${c.deltas[run.role]?.text ? `\n\nEarlier instructions still apply:\n${c.deltas[run.role]!.text}` : ""}` };
      ev(e, { type: "run.reask", role: run.role, agent: run.agent, run_id: run.run_id, data: { errors } });
      return { status: "reask", decision: null, artifact: null, errors };
    }
    block(e, "result_invalid", `${run.role} did not return a readable result block twice: ${errors.join("; ")}`, `See .looprch/runs/${run.run_id}/final.md, then run looprch resume to try again`);
    return { status: "rejected", decision: null, artifact: null, errors };
  }
  run.decision = result.decision;
  finish("completed");
  const reported: Finding[] = result.findings ?? result.failures ?? [];
  ev(e, {
    type: "result.accepted",
    role: run.role,
    agent: run.agent,
    run_id: run.run_id,
    data: {
      decision: result.decision,
      touched: run.touched_files.length,
      task: run.task,
      ...(run.wall_ms !== undefined ? { wall_ms: run.wall_ms } : {}),
      ...(run.usage ? { usage: run.usage } : {}),
      findings_total: reported.length,
      severities: severityCounts(reported),
      findings: reported.map((f) => ({ id: f.id, ...(f.severity ? { severity: f.severity } : {}), ...("owner" in f && f.owner ? { owner: f.owner } : {}), summary: f.summary.slice(0, 300) })),
      ...(run.task === "review" && !run.side ? { review_round: (st.current?.review_changes ?? 0) + 1, review_cap: reviewCap(e) } : {}),
      ...(result.resolutions ? { resolutions: result.resolutions.map((r) => ({ id: r.id, status: r.status })) } : {}),
      ...(result.debate_dispositions ? { dispositions: result.debate_dispositions.map((d) => ({ id: d.id, decision: d.decision })) } : {}),
      ...(result.todos_done ? { todos_done: result.todos_done } : {}),
    },
  });
  if (run.side) return { status: "accepted", decision: result.decision, artifact: writeSideOutput(e, run, artifact, result), errors: [] };
  const c = cur(e);
  c.reask_count = 0;
  c.attempts[run.role] = 0;
  const priorDelta = c.deltas[run.role];
  delete c.deltas[run.role];
  const path = applyResult(e, run, result, artifact, priorDelta ?? null);
  return { status: "accepted", decision: result.decision, artifact: path, errors: [] };
}

/**
 * Expansion requests name SEV3 sources only: a document id (or a requirement id a document
 * carries) or a phase id of the manifest; the toolkit cannot build anything else.
 */
function expansionProblems(e: Engine, requests: ExpansionRequest[]): string[] {
  const docs = new Set(e.manifest.documents.flatMap((d) => [d.id, ...d.ids]));
  const phases = new Set(e.manifest.phases.map((p) => p.id));
  const bad = requests.filter((x) => (x.kind === "document" ? !docs.has(x.id) : !phases.has(x.id))).map((x) => `${x.kind} ${x.id}`);
  if (!bad.length) return [];
  const sample = e.manifest.documents.slice(0, 12).map((d) => d.id).join(", ");
  return [
    `expansion requests must name SEV3 document ids (from phases/manifest.json, for example ${sample}) or phase ids; not: ${bad.join(", ")}. Project files are read directly from the repository. If a source the plan needs does not exist, decide the behavior in the plan (or defer it) instead of requesting it.`,
  ];
}

function writeSideOutput(e: Engine, run: RunRecord, artifact: string, result: RoleResult): string {
  const dir = run.task === "worker" ? join(projectPaths(e.root).phase(run.phase ?? "_project"), "workers") : join(projectPaths(e.root).phase(run.phase!), "reviews");
  ensureDir(dir);
  const name = run.task === "worker" ? `${run.run_id}.md` : `adhoc-${run.run_id.split("-adhoc-")[1] ?? Date.now()}.md`;
  const text = `${artifact.trim()}\n\n<!-- looprch ${run.task} ${run.run_id} via ${run.agent}/${run.model}; decision ${result.decision}; advisory only -->\n`;
  writeFileAtomic(join(dir, name), text);
  run.output_path = rel(e, join(dir, name));
  saveRun(e.root, run);
  return run.output_path;
}

function executeExpansions(e: Engine, role: Role, requests: ExpansionRequest[]): string[] {
  const c = cur(e);
  const paths: string[] = [];
  for (const r of requests) {
    const p = buildPacket(e.root, c.phase, role, r.kind === "document" ? { documents: [r.id], question: r.question, reason: r.reason } : { phases: [r.id], question: r.question, reason: r.reason });
    paths.push(p.path);
    ev(e, { type: "expansion.executed", role, data: { request: r, packet: p.path, bytes: p.bytes } });
  }
  return paths;
}

/** Reviews that may request changes in this phase: the configured limit plus the user's extra reviews. */
function reviewCap(e: Engine): number {
  return reviewRounds(e.cfg) + (e.st.current?.extra_reviews ?? 0);
}

function reviewsExhausted(e: Engine): boolean {
  return (cur(e).review_changes ?? 0) >= reviewCap(e);
}

function findingSummary(list: Finding[]): string {
  return list.map((f) => f.summary).join("; ");
}

/**
 * Enter the repair stage with the findings. Review repairs are bounded by the review limit;
 * test/gate repairs by limits.repair_rounds. At that limit it blocks in the repair stage, so
 * `looprch resume` (one extra round) continues with the repair, never with another review.
 */
function repairOrBlock(e: Engine, source: "test" | "review", findings: Finding[], paths: string[], summary: string): void {
  const c = cur(e);
  c.round++;
  c.repair_source = source;
  if (source === "test") {
    const used = c.test_repairs ?? 0;
    c.test_repairs = used + 1;
    c.deltas.implementer = { kind: "repair", text: `Repair round ${c.round} (tests or gates failed). Fix every problem below at its root cause, including the same defect anywhere else in the phase:`, findings, paths };
    c.deltas.tester = { kind: "repair", text: `Round ${c.round}: the Implementer repaired the problems below. Run the tests again; change a test only where the test itself was wrong.`, findings };
    transition(e, "repairing");
    if (used >= e.cfg.limits.repair_rounds + c.extra_rounds)
      block(e, "repair_limit", `Repair limit reached (${used} test/gate repair round(s)) with open problems: ${summary}`, 'Decide: run looprch resume --note "<instruction>" for one more round, or raise limits.repair_rounds with looprch config set', { findings });
    return;
  }
  const finalRepair = reviewsExhausted(e);
  const mine = findings.filter((f) => f.owner !== "tester");
  const theirs = findings.filter((f) => f.owner === "tester");
  const head = finalRepair ? `Final repair round ${c.round} (the review requested changes; no further review follows)` : `Repair round ${c.round} (the review requested changes)`;
  if (mine.length)
    c.deltas.implementer = {
      kind: "repair",
      text: [`${head}. Fix every finding below at its root cause, wherever the same defect occurs, so that its Fix condition holds.`, ...(theirs.length ? [`The Tester fixes these test findings after you: ${theirs.map((f) => `${f.id} (${f.summary})`).join("; ")}`] : [])].join("\n"),
      findings: mine,
      paths,
    };
  else delete c.deltas.implementer;
  c.deltas.tester = { kind: "repair", text: `Round ${c.round}: review findings. Fix the findings owned by the Tester, and add tests that prove the other repairs (each one must fail without the fix).`, findings, paths };
  if (finalRepair) delete c.deltas.reviewer;
  else c.deltas.reviewer = { kind: "rereview", text: "Your previous review requested the changes below. Check each one against the current code, report the ones that still hold (keep their ids) and anything new, and check the repair diff for regressions.", findings, paths };
  transition(e, mine.length ? "repairing" : "testing");
}

function finalReviewQuestion(e: Engine): Action {
  const c = cur(e);
  const qid = `final_review-${c.phase}-${c.review_changes ?? 0}`;
  const serious = c.review_findings.filter((f) => f.severity === "high" || f.severity === "critical").length;
  return ask(
    e,
    "final_review",
    qid,
    `The final review (${c.review_changes ?? 0} of ${reviewCap(e)}) of ${c.phase} still requests changes: ${c.review_findings.length} finding(s), ${serious} high or critical (see .looprch/phases/${c.phase}/review.md). How should Looprch continue?`,
    [
      { id: "repair_and_review", label: "Repair, then run one more review" },
      { id: "repair_and_handover", label: "Repair, then hand over without another review (findings listed in handover.md)" },
      { id: "pause", label: "Pause" },
    ],
  );
}

function answerFinalReview(e: Engine, qid: string, option: string): void {
  const c = cur(e);
  if (option === "pause") {
    delete e.st.answers[qid];
    e.st.flags.paused = { reason: "paused at the final review decision; run looprch resume to decide", at: nowIso() };
    return;
  }
  c.final_review_pending = false;
  if (option === "repair_and_review") c.extra_reviews = (c.extra_reviews ?? 0) + 1;
  repairOrBlock(e, "review", c.review_findings, [rel(e, phaseFile(e, "review.md"))], findingSummary(c.review_findings));
}

/** After passing gates: review, or go straight to handover once the review limit is reached. */
function afterGatesPassed(e: Engine): void {
  const c = cur(e);
  if (!reviewsExhausted(e)) {
    transition(e, "reviewing");
    return;
  }
  c.snapshots.review = null;
  delete c.deltas.reviewer;
  c.deltas.implementer = { kind: "unreviewed", text: "The final review requested the changes below; they were repaired but not reviewed again. In Limitations, say for each finding whether it is fully fixed.", findings: c.review_findings };
  ev(e, { type: "review.skipped", data: { limit: reviewCap(e), findings: c.review_findings.map((f) => f.id) } });
  transition(e, "handover");
}

function recordImplementer(e: Engine, run: RunRecord): void {
  const p = e.st.phases[cur(e).phase]!;
  const entry = p.implementers.find((x) => x.agent === run.agent && x.model === run.model);
  if (entry) entry.runs.push(run.run_id);
  else p.implementers.push({ agent: run.agent, model: run.model, runs: [run.run_id] });
}

// ---------------------------------------------------------------------------------------------
// plan debate

function entryFinding(x: DebateEntry, withDisposition: boolean): Finding {
  const d = x.disposition;
  const parts = [x.summary];
  if (x.section) parts.push(`(section: ${x.section})`);
  if (withDisposition && d) parts.push(`Planner (round ${d.round}): ${d.decision}${d.note ? `: ${d.note}` : ""}`);
  const last = x.verdicts.at(-1);
  if (last) parts.push(`Debater (round ${last.round}): ${last.verdict}${last.note ? `: ${last.note}` : ""}`);
  return { id: x.id, severity: x.severity, summary: parts.join(" "), ...(x.suggestion ? { fix: x.suggestion } : {}) };
}

/** The Planner answers every open debate item in a full revision of the plan. */
function toSynthesis(e: Engine, l: DebateLedger, note = ""): void {
  const c = cur(e);
  c.deltas.planner = {
    kind: "synthesis",
    text: [
      `Debate round ${l.rounds} of ${debateRounds(e.cfg)}: answer every open item below in "debate_dispositions", then write the full revised plan and the complete plan block.`,
      "- accept: change the plan so the problem cannot happen, and say in note what you changed.",
      "- reject: say in note why the finding does not hold. Rejecting is right when the finding is wrong; the Plan Debater judges every answer in the next round.",
      ...(note ? [note] : []),
    ].join("\n"),
    findings: openEntries(l).map((x) => entryFinding(x, false)),
  };
  transition(e, "synthesizing");
}

/** The Plan Debater judges the Planner's answers against the revised plan. */
function toRebuttal(e: Engine, l: DebateLedger): void {
  const c = cur(e);
  c.deltas.plan_debater = {
    kind: "rebuttal",
    text: [
      `Debate round ${l.rounds + 1} of ${debateRounds(e.cfg)}. The Planner answered the items below and revised the plan. For every item give one verdict:`,
      "- resolved: the revised plan closes it.",
      "- conceded: the Planner's rejection is right.",
      "- upheld: the answer does not close it; say in note what is still missing.",
      'Report new defects only when they are high or critical. Decision "agree" when nothing is upheld and nothing new above low remains.',
    ].join("\n"),
    findings: openEntries(l).map((x) => entryFinding(x, true)),
  };
  transition(e, "debating");
}

/** After a Planner plan result: record the answers and decide whether the debate continues. */
function afterPlan(e: Engine, task: Task, r: RoleResult): void {
  const c = cur(e);
  const ledger = loadLedger(e.root, c.phase);
  if (task === "synthesis" || r.debate_dispositions?.length) applyDispositions(ledger, r.debate_dispositions ?? []);
  if (c.debate_final?.length) {
    const decided = new Set(c.debate_final);
    const open = openEntries(ledger);
    closeEntries(open.filter((x) => decided.has(x.id)), "user_decided", "the user sided with the Plan Debater; the Planner applied it");
    closeEntries(open.filter((x) => !decided.has(x.id)), "contested", "debate limit reached; the Reviewer checks it");
    c.debate_final = null;
    saveLedger(e.root, ledger);
    afterDebate(e);
    return;
  }
  saveLedger(e.root, ledger);
  const open = openEntries(ledger);
  if (task === "planning") {
    delete c.deltas.plan_debater;
    const unmapped = unmappedRequirements(loadPlan(e.root, c.phase), phaseDef(e, c.phase));
    if (unmapped.length) c.deltas.plan_debater = { kind: "notes", text: `Requirements of ${c.phase} that the plan's requirement map does not mention: ${unmapped.join(", ")}. Check whether the plan delivers them.` };
    transition(e, "debating");
    return;
  }
  if (!open.length) {
    afterDebate(e);
    return;
  }
  if (open.every((x) => !SERIOUS.has(x.severity) && x.severity !== "medium")) {
    closeEntries(open.filter((x) => x.disposition?.decision !== "reject"), "resolved", "low severity: answered by the Planner, not re-checked");
    closeEntries(open.filter((x) => x.disposition?.decision === "reject"), "conceded", "low severity: rejected by the Planner, not re-checked");
    saveLedger(e.root, ledger);
    afterDebate(e);
    return;
  }
  toRebuttal(e, ledger);
}

/** The debate ended: plan approval next. */
function afterDebate(e: Engine): void {
  const c = cur(e);
  delete c.deltas.plan_debater;
  if (c.deltas.planner?.kind === "synthesis") delete c.deltas.planner;
  ev(e, { type: "debate.closed", data: ledgerSummary(loadLedger(e.root, c.phase)) });
  transition(e, "plan_approval");
}

/** At the debate limit: serious open items go to the user; the others are contested and checked by the Reviewer. */
function debateLimitReached(e: Engine, l: DebateLedger): Action | null {
  const c = cur(e);
  const open = openEntries(l);
  const serious = open.filter((x) => SERIOUS.has(x.severity));
  if (!serious.length) {
    closeEntries(open, "contested", "debate limit reached; the Reviewer checks it in the first review");
    saveLedger(e.root, l);
    afterDebate(e);
    return null;
  }
  const qid = `debate_unresolved-${c.phase}-r${l.rounds}`;
  return ask(
    e,
    "debate_unresolved",
    qid,
    `The plan debate for ${c.phase} reached its limit (${l.rounds} Debater passes) with ${serious.length} high or critical item(s) the Planner and the Plan Debater still disagree on: ${serious.map((x) => entryLine(x)).join(" | ")}. Read .looprch/phases/${c.phase}/debate.json and debate.md. Who is right?`,
    [
      { id: "planner", label: "Keep the Planner's plan (the items are recorded as decided by you)" },
      { id: "debater", label: "Side with the Plan Debater: the Planner applies its suggestion in one more revision" },
      { id: "pause", label: "Pause" },
    ],
    { items: serious.map((x) => x.id) },
  );
}

function answerDebateUnresolved(e: Engine, qid: string, option: string, items: string[]): void {
  const c = cur(e);
  const l = loadLedger(e.root, c.phase);
  if (option === "pause") {
    delete e.st.answers[qid];
    e.st.flags.paused = { reason: "paused at the unresolved plan debate; run looprch resume to decide", at: nowIso() };
    return;
  }
  const open = openEntries(l);
  if (option === "planner") {
    closeEntries(open.filter((x) => items.includes(x.id)), "user_decided", "the user kept the Planner's position");
    closeEntries(open.filter((x) => !items.includes(x.id)), "contested", "debate limit reached; the Reviewer checks it");
    saveLedger(e.root, l);
    afterDebate(e);
    return;
  }
  c.debate_final = items;
  toSynthesis(e, l, `The user decided ${items.join(", ")} for the Plan Debater: accept each one and apply its suggestion. This is the last revision of the debate.`);
}

// ---------------------------------------------------------------------------------------------
// implementation sessions

/** Plan approved: the Implementer works through the Planner's sessions, one run each. */
function startImplementation(e: Engine): void {
  const c = cur(e);
  const plan = loadPlan(e.root, c.phase);
  const n = plan ? normalizeSessions(plan) : { sessions: [], notes: [] };
  for (const note of n.notes) ev(e, { type: "warning", data: { message: `Plan sessions: ${note}` } });
  c.sessions = n.sessions.length ? n.sessions : null;
  c.session_index = 0;
  c.todos_done = [];
  c.followup_sessions = [];
  e.st.pending_checkpoint = { label: "plan approved" };
  transition(e, "implementing");
}

/** A session ended: record its todos, queue open ones once as a follow-up session, then the next session or testing. */
function finishSession(e: Engine, run: RunRecord, r: RoleResult): void {
  const c = cur(e);
  const sessions = c.sessions ?? [];
  const idx = c.session_index ?? 0;
  const ids = sessions[idx] ?? [];
  const reported = r.todos_done;
  const done = reported ? ids.filter((id) => reported.includes(id)) : ids;
  c.todos_done = [...new Set([...(c.todos_done ?? []), ...done])];
  const open = ids.filter((id) => !c.todos_done!.includes(id));
  const followups = c.followup_sessions ?? [];
  if (open.length && !followups.includes(idx)) {
    sessions.splice(idx + 1, 0, open);
    c.followup_sessions = [...followups.map((i) => (i > idx ? i + 1 : i)), idx + 1];
    ev(e, { type: "warning", data: { message: `Session ${idx + 1} left ${open.join(", ")} open; Looprch queues them once as a follow-up session` } });
  } else if (open.length) ev(e, { type: "warning", data: { message: `The follow-up session still left ${open.join(", ")} open; the Tester and the Reviewer will see what is missing` } });
  ev(e, { type: "work.done", role: "implementer", run_id: run.run_id, data: { session: idx + 1, sessions: sessions.length, todos: done, open } });
  c.session_index = idx + 1;
  e.st.pending_checkpoint = { label: sessions.length > 1 ? `implementation session ${idx + 1}` : "implementation" };
  if (c.session_index < sessions.length) return;
  transition(e, "testing");
}

/** The Planner's answer to the Implementer: appended to plan.md; new todos join the current session. */
function acceptContextAnswer(e: Engine, r: RoleResult, artifact: string): string {
  const c = cur(e);
  const n = c.addenda.length + 1;
  const planMd = phaseFile(e, "plan.md");
  const old = existsSync(planMd) ? readFileSync(planMd, "utf8").trim() : "";
  const question = c.context_request?.question ?? "";
  const path = writeArtifact(e, "plan.md", `${old}\n\n## Addendum ${n}: answer to the Implementer\n\n**Question:** ${question}\n\n${artifact.trim()}`);
  c.addenda.push(`Addendum ${n}`);
  const added: string[] = [];
  const plan = loadPlan(e.root, c.phase);
  if (r.new_todos?.length && plan) {
    const taken = new Set(plan.todos.map((t) => t.id));
    const fresh = r.new_todos.filter((t) => !taken.has(t.id));
    if (fresh.length) {
      savePlan(e.root, { ...plan, revision: plan.revision + 1, todos: [...plan.todos, ...fresh] });
      added.push(...fresh.map((t) => t.id));
      if (c.stage === "implementing" && c.sessions?.length) c.sessions[c.session_index ?? 0]!.push(...added);
    }
  }
  const prior = c.deltas.implementer;
  const answered = `The Planner answered your question in plan.md (Addendum ${n}, at the end).${added.length ? ` It added ${added.join(", ")}; do ${added.length > 1 ? "them" : "it"} in this run too.` : ""} Continue.`;
  const rest = prior?.text?.startsWith("The Planner answered") ? prior.text.split("\n\n").slice(1).join("\n\n") : prior?.text;
  c.deltas.implementer = { ...(prior ?? {}), kind: prior?.kind ?? "context_answer", text: rest ? `${answered}\n\n${rest}` : answered };
  c.context_request = null;
  return path;
}

// ---------------------------------------------------------------------------------------------
// applying accepted results

function applyResult(e: Engine, run: RunRecord, r: RoleResult, artifact: string, priorDelta: Delta | null): string | null {
  const c = cur(e);
  const expansion = (role: Role): boolean => {
    if (r.decision !== "needs_expansion") return false;
    if (c.expansion_round >= e.cfg.limits.expansion_rounds) {
      block(e, "expansion_limit", `${role} asked for more sources after ${c.expansion_round} expansion round(s)`, "Review the requests in the run's final.md; run looprch resume to allow another round");
      return true;
    }
    c.expansion_round++;
    try {
      const paths = executeExpansions(e, role, r.expansion_requests ?? []);
      c.deltas[role] = { kind: "expansion", text: "The extra sources you asked for (exact original text; they change no scope):", paths };
    } catch (err) {
      block(e, (err as LrError).code === "spec_changed" ? "spec_changed" : "config_invalid", errorMessage(err), (err as LrError).hint ?? `The SEV3 toolkit could not build the expansion the ${role} asked for (see .looprch/runs/${run.run_id}/final.md). Run looprch resume to run the ${role} again.`);
    }
    return true;
  };
  switch (run.task) {
    case "planning":
    case "synthesis":
    case "revise": {
      if (expansion("planner")) return null;
      const path = writeArtifact(e, "plan.md", artifact);
      if (r.plan) {
        const prev = loadPlan(e.root, c.phase);
        const saved = newPlan(c.phase, r.plan, (prev?.revision ?? 0) + 1);
        savePlan(e.root, saved);
        ev(e, { type: "plan.accepted", role: "planner", run_id: run.run_id, data: { task: run.task, todos: saved.todos.length, sessions: normalizeSessions(saved).sessions.length, deferrals: saved.deferrals?.length ?? 0, dispositions: r.debate_dispositions?.length ?? 0, plan_bytes: Buffer.byteLength(artifact) } });
      }
      afterPlan(e, run.task, r);
      return path;
    }
    case "debate":
    case "rebuttal": {
      if (expansion("plan_debater")) return null;
      const path = writeArtifact(e, "debate.md", artifact || "No findings.");
      const ledger = loadLedger(e.root, c.phase);
      ledger.rounds++;
      if (run.task === "rebuttal") applyVerdicts(ledger, r.verdicts ?? []);
      addEntries(
        ledger,
        (r.findings ?? []).map((f) => ({ id: f.id, source: "debater" as const, severity: f.severity ?? "medium", summary: f.summary, round: ledger.rounds, ...(f.section ? { section: f.section } : {}), ...(f.suggestion ? { suggestion: f.suggestion } : {}) })),
      );
      if (r.decision === "agree") closeEntries(openEntries(ledger), "resolved", "the Plan Debater agreed with the revised plan");
      saveLedger(e.root, ledger);
      const open = openEntries(ledger);
      ev(e, { type: "debate.round", role: "plan_debater", run_id: run.run_id, data: { round: ledger.rounds, cap: debateRounds(e.cfg), decision: r.decision, raised: (r.findings ?? []).length, verdicts: (r.verdicts ?? []).map((v) => ({ id: v.id, verdict: v.verdict })), open: open.length } });
      if (!open.length) afterDebate(e);
      else if (ledger.rounds < debateRounds(e.cfg)) toSynthesis(e, ledger);
      return path;
    }
    case "context_answer":
      return acceptContextAnswer(e, r, artifact);
    case "implementation":
    case "repair": {
      if (r.decision === "needs_context") {
        c.context_request = { question: r.context_request!.question, reason: r.context_request!.reason ?? "" };
        c.deltas.planner = {
          kind: "context_answer",
          text: `The Implementer is blocked and asks: ${c.context_request.question}\nWhy: ${c.context_request.reason || "(no reason given)"}\n\nAnswer so the Implementer can continue: the decision, and exactly what to do. If the answer needs new work, add it as "new_todos".`,
        };
        if (priorDelta) c.deltas.implementer = priorDelta;
        return null;
      }
      recordImplementer(e, run);
      if (run.task === "implementation") {
        finishSession(e, run, r);
        return null;
      }
      c.repair_reports = [...(c.repair_reports ?? []), rel(e, join(projectPaths(e.root).run(run.run_id), "final.md"))];
      e.st.pending_checkpoint = { label: `repair ${c.round}` };
      transition(e, "testing");
      return null;
    }
    case "testing": {
      const path = writeArtifact(e, "test-report.md", artifact);
      c.tester_verdict = r.decision === "pass" ? "pass" : "fail";
      c.tester_failures = (r.failures ?? []).map((f) => ({ id: f.id, summary: f.summary, gate_id: f.gate_id, files: f.files }));
      for (const m of r.manual_gate_reports ?? []) c.manual_reports[m.gate_id] = m.path;
      transition(e, "gating");
      return path;
    }
    case "review": {
      const path = writeArtifact(e, "review.md", artifact);
      for (const m of r.manual_gate_reports ?? []) c.manual_reports[m.gate_id] = m.path;
      const findings: Finding[] = (r.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, summary: f.summary, ...(f.files?.length ? { files: f.files } : {}), ...(f.fix ? { fix: f.fix } : {}), ...(f.owner ? { owner: f.owner } : {}) }));
      c.repair_reports = [];
      if (r.decision === "approve") {
        c.snapshots.review = c.snapshots.gates;
        c.review_findings = [];
        c.review_notes = findings;
        if (findings.length) c.deltas.implementer = { kind: "notes", text: "The Reviewer approved with the notes below; they are not repaired. List each one in Limitations.", findings };
        transition(e, "handover");
      } else {
        c.review_findings = findings;
        c.review_changes = (c.review_changes ?? 0) + 1;
        c.test_repairs = 0;
        c.extra_rounds = 0;
        c.reviewed_tree = c.snapshots.gates;
        if (reviewsExhausted(e)) c.final_review_pending = true;
        else repairOrBlock(e, "review", findings, [path], findingSummary(findings));
      }
      return path;
    }
    case "handover":
      return acceptHandover(e, run, artifact);
    case "adhoc_review":
    case "worker":
      return null;
    default: {
      const never: never = run.task;
      throw new LrError("internal", `unhandled task ${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// handover

function findingLines(findings: Finding[]): string[] {
  return findings.map((f) => `- ${f.id}${f.severity ? ` [${f.severity}]` : ""}: ${f.summary}${f.files?.length ? ` (${f.files.join(", ")})` : ""}`);
}

function unreviewedSection(e: Engine, findings: Finding[]): string {
  const lines = findingLines(findings);
  return [
    "",
    "## Open review findings (final repair, not re-reviewed)",
    "",
    `Review ${cur(e).review_changes ?? 0} of ${reviewCap(e)} requested these changes. The Implementer repaired them and the gates passed, but no further review ran (you chose to hand over):`,
    "",
    ...(lines.length ? lines : ["- (none recorded)"]),
    "",
  ].join("\n");
}

function notesSection(findings: Finding[]): string {
  if (!findings.length) return "";
  return ["", "## Open review notes (approved, not repaired)", "", "The approving review listed these findings without requesting changes:", "", ...findingLines(findings), ""].join("\n");
}

function filesSection(d: ReturnType<typeof diffNameStatus>): string {
  const list = (title: string, items: string[]) => [`### ${title}`, "", ...(items.length ? items.map((p) => `- ${p}`) : ["- none"]), ""];
  return [...list("Modified files", d.modified), ...list("New files", d.added), ...list("Deleted files", d.deleted), ...list("Renamed files", d.renamed.map((r) => `${r.from} -> ${r.to}`))].join("\n").trim();
}

function planSection(plan: Plan | null, done: string[]): string {
  if (!plan) return "- (this phase has no plan.json)";
  const finished = new Set(done);
  const lines = [`Plan revision ${plan.revision}: ${plan.todos.length} todo(s), ${finished.size} reported done by the Implementer.`, ""];
  for (const t of plan.todos) lines.push(`- ${t.id} [${finished.has(t.id) ? "done" : "not reported"}]: ${t.title}`);
  lines.push("", "### Deferrals to later phases", "");
  const deferrals = plan.deferrals ?? [];
  if (!deferrals.length) lines.push("- none");
  for (const d of deferrals) lines.push(`- ${d.id} -> ${d.to_phase}: ${d.what}${d.interim ? `. Until then: ${d.interim}` : ""}`);
  return lines.join("\n");
}

function debateSection(l: DebateLedger): string {
  if (!l.entries.length && !l.rounds) return "- no debate recorded";
  const s = ledgerSummary(l);
  const lines = [`${s.rounds} Plan Debater pass(es), ${s.items} item(s): ${s.resolved} resolved, ${s.conceded} conceded, ${s.contested} contested, ${s.user_decided} decided by the user.`];
  const unsettled = l.entries.filter((x) => x.status === "contested" || x.status === "user_decided");
  if (unsettled.length) lines.push("", ...unsettled.map((x) => `- ${entryLine(x)} (${x.status}${x.closed_note ? `: ${x.closed_note}` : ""})`));
  return lines.join("\n");
}

function acceptHandover(e: Engine, run: RunRecord, artifact: string): string | null {
  const c = cur(e);
  const snap = snapshotTree(e.root);
  if (snap !== c.snapshots.gates) {
    ev(e, { type: "warning", data: { message: "The handover run changed files; gates and review must run again" } });
    c.snapshots.review = null;
    transition(e, "gating");
    return null;
  }
  const actual = diffNameStatus(e.root, c.phase_base!, snap);
  const p = e.st.phases[c.phase]!;
  const gates = loadGates(e.root, c.phase);
  const tpl = readFileSync(join(packageRoot(), "assets", "templates", "handover.md"), "utf8");
  const extra = tpl
    .replace("{{files}}", filesSection(actual))
    .replace("{{contributors}}", p.implementers.map((i) => `- ${i.agent} / ${i.model}: runs ${i.runs.join(", ")}`).join("\n") || "- (none recorded)")
    .replace(
      "{{gate_runs}}",
      Object.values(gates.latest)
        .map((id) => {
          const g = gates.runs.find((x) => x.gate_run_id === id)!;
          return `- ${g.gate_id}: ${g.gate_run_id}, ${g.ok ? "passed" : "failed"}, tests ${g.evidence.tests}, evidence sha256 ${g.evidence.sha256 ?? "-"}, tree ${g.snapshot_tree}`;
        })
        .join("\n"),
    )
    .replace("{{unreviewed}}", `${c.snapshots.review ? "" : unreviewedSection(e, c.review_findings)}${notesSection(c.review_notes ?? [])}`)
    .replace("{{plan}}", planSection(loadPlan(e.root, c.phase), c.todos_done ?? []))
    .replace("{{debate}}", debateSection(loadLedger(e.root, c.phase)));
  const path = writeArtifact(e, "handover.md", `${artifact.trim()}\n${extra}`);
  c.snapshots.handover = snap;
  ev(e, { type: "handover.accepted", run_id: run.run_id, data: { files: actual } });
  c.close_step = "ticks";
  transition(e, "closing");
  return path;
}

// ---------------------------------------------------------------------------------------------
// gates, checkpoints, closing, finish

export interface GateExtras {
  /** The optional e2e gate of this batch. */
  e2e?: { outcome: E2eOutcome; reason: string | null; tree: string };
}

const E2E_HINTS: Record<Exclude<E2eOutcome, "pass" | "fail">, string> = {
  config: "Fix the e2e setup (run /lr-e2e-test-init, or looprch e2e configure), or turn the gate off with looprch e2e disable; then run looprch resume",
  missing: "Install the e2e package in the project (looprch e2e init --install) and run looprch e2e configure, or run looprch e2e disable; then looprch resume",
  environment: "Check that the app starts and the model provider is reachable (see the LR-E2E .out/.err files of the gate run), then looprch resume to run the gates again; or looprch e2e disable",
  runner: "The e2e runner failed internally or was interrupted; looprch resume runs the gates again, or looprch e2e disable",
};

export function applyGates(e: Engine, outcome: GatesOutcome, extras: GateExtras = {}): void {
  const c = cur(e);
  for (const r of outcome.runs) ev(e, { type: "gate.result", data: { gate_id: r.gate_id, gate_run_id: r.gate_run_id, ok: r.ok, reason: r.reason, tests: r.evidence.tests } });
  ev(e, { type: "gates.run", data: { all_passed: outcome.all_passed, snapshot: outcome.snapshot_tree, ...(outcome.cached ? { cached: true } : {}), ...(extras.e2e ? { e2e: extras.e2e.outcome } : {}) } });
  const e2e = extras.e2e;
  if (e2e?.outcome === "pass") c.e2e_passed_tree = e2e.tree;
  if (e2e && e2e.outcome !== "pass" && e2e.outcome !== "fail") {
    block(e, `e2e_${e2e.outcome}`, `The optional e2e gate could not judge the application: ${e2e.reason ?? e2e.outcome}`, E2E_HINTS[e2e.outcome]);
    return;
  }
  if (outcome.all_passed && c.tester_verdict === "pass") {
    c.snapshots.gates = outcome.snapshot_tree;
    afterGatesPassed(e);
    return;
  }
  const findings: Finding[] = outcome.runs.filter((r) => !r.ok).map((r) => ({ id: r.gate_run_id, gate_id: r.gate_id, summary: `${r.reason ?? "failed"}${r.stdout_tail ? `\n${r.stdout_tail.split("\n").slice(-8).join("\n")}` : ""}` }));
  findings.push(...c.tester_failures);
  const paths = outcome.runs.filter((r) => !r.ok).flatMap((r) => [r.stdout_path, r.stderr_path]);
  repairOrBlock(e, "test", findings, paths, findings.map((f) => f.gate_id ?? f.id).join(", ") || "tester verdict fail");
}

export function doCheckpoint(e: Engine): { label: string | null; commit: string | null } {
  const st = e.st;
  const pending = st.pending_checkpoint;
  if (!pending || !st.current) return { label: null, commit: null };
  const c = st.current;
  st.pending_checkpoint = null;
  persist(e);
  let sha: string | null;
  try {
    sha = commitAll(e.root, `looprch(${c.phase}): ${pending.label}`);
  } catch (err) {
    st.pending_checkpoint = pending;
    block(e, (err as LrError).code ?? "hook_failed", errorMessage(err), (err as LrError).hint ?? "");
    return { label: pending.label, commit: null };
  }
  if (sha) {
    c.last_commit = sha;
    ev(e, { type: "checkpoint.committed", data: { label: pending.label, commit: sha } });
  }
  return { label: pending.label, commit: sha };
}

function runClosing(e: Engine, phase: PhaseDef): Action | null {
  const c = cur(e);
  const st = e.st;
  if (!c.close_step || c.close_step === "ticks") {
    const keys = [`${c.phase}:implementation`, ...phase.gates.map((g) => `${c.phase}:gate:${g.id}`), `${c.phase}:independent-test`, `${c.phase}:independent-review`, `${c.phase}:handover`, c.phase];
    for (const k of keys) if (tick(e.root, k).changed) ev(e, { type: "todo.ticked", data: { key: k } });
    const v = verifyPackage(e.root);
    if (!v.ok) return block(e, "spec_changed", `The package no longer verifies after ticking todo.md: ${v.error}`, "Inspect phases/todo.md; only Looprch edits it");
    c.close_step = "merge_approval";
  }
  if (c.close_step === "merge_approval") {
    if (approvalApplies(e.cfg.approvals.merge, phase)) {
      const qid = `approve_merge-${c.phase}`;
      const ans = st.answers[qid];
      if (!ans) return ask(e, "approve_merge", qid, `Merge ${c.phase} "${c.title}" into ${st.git.base_branch}? Review: git diff ${c.phase_base?.slice(0, 10)} ${c.branch ?? "HEAD"}`, [{ id: "merge", label: "Merge" }, { id: "hold", label: "Hold (pause)" }]);
      if (ans === "hold") {
        delete st.answers[qid];
        st.flags.paused = { reason: `merge of ${c.phase} held by the user; run looprch resume when ready`, at: nowIso() };
        return null;
      }
    }
    c.close_step = "commit";
  }
  const phaseId = c.phase;
  const title = c.title;
  c.close_step = "merge";
  persist(e);
  let res;
  try {
    res = closePhase(e.root, phaseId, title, st.git.base_branch ?? "main", e.cfg.git.phase_branches);
  } catch (err) {
    c.last_commit = head(e.root);
    c.close_step = "commit";
    const code = (err as LrError).code;
    return block(e, code === "merge_conflict" || code === "hook_failed" || code === "no_git_identity" ? code : "merge_conflict", errorMessage(err), (err as LrError).hint ?? "", (err as LrError).details ?? null);
  }
  const rec = st.phases[phaseId]!;
  rec.status = "closed";
  rec.closed_at = nowIso();
  rec.merge_commit = res.merge_commit;
  rec.tag = res.tag;
  rec.rounds_used = c.round;
  ev(e, { type: "phase.merged", data: { merge_commit: res.merge_commit, close_commit: res.close_commit } });
  ev(e, { type: "phase.closed", data: { tag: res.tag } });
  st.current = null;
  return { protocol: PROTOCOL, phase: phaseId, stage: "closed", round: rec.rounds_used, summary: `${phaseId} closed and merged (tag ${res.tag})`, action: "phase_closed", tag: res.tag, merge_commit: res.merge_commit };
}

function finishProject(e: Engine): Action {
  const st = e.st;
  if (tick(e.root, "PROJECT:production-readiness").changed) ev(e, { type: "todo.ticked", data: { key: "PROJECT:production-readiness" } });
  const verify = verifyPackage(e.root);
  const lines = [
    `# Final report: ${e.manifest.project.title}`,
    "",
    `Project id: ${e.manifest.project.id}. Generated by Looprch on ${nowIso()}.`,
    "",
    `Specification verified by the SEV3 toolkit: ${verify.ok ? "yes" : "no"}. semantic_translation_verified: ${verify.semantic_translation_verified}; application_verified (toolkit field): ${verify.application_verified}. The application evidence is the gate runs below, not the specification check.`,
    "",
    "## Phases",
    "",
  ];
  for (const p of e.manifest.phases) {
    const r = st.phases[p.id];
    const gates = loadGates(e.root, p.id);
    lines.push(`### ${p.id} ${p.title} (${p.kind}, risk ${p.risk})`, "", `- Status: ${r?.status ?? "not run"}; tag ${r?.tag ?? "-"}; merge ${r?.merge_commit ?? "-"}; repair rounds ${r?.rounds_used ?? 0}`);
    lines.push(`- Implementers: ${(r?.implementers ?? []).map((i) => `${i.agent}/${i.model}`).join(", ") || "-"}`);
    for (const id of Object.values(gates.latest)) {
      const g = gates.runs.find((x) => x.gate_run_id === id);
      if (g) lines.push(`- Gate ${g.gate_id}: ${g.ok ? "passed" : "FAILED"} (${g.gate_run_id}, ${g.evidence.tests} tests, tree ${g.snapshot_tree.slice(0, 12)})`);
    }
    lines.push(`- Handover: .looprch/phases/${p.id}/handover.md`, "");
  }
  lines.push("## Assignment changes", "", ...(st.assignments_history.filter((h) => h.reason !== "config").map((h) => `- ${h.phase} ${h.role}: ${h.from?.agent ?? "-"} -> ${h.to.agent} (${h.reason})`) || []), "");
  writeFileAtomic(projectPaths(e.root).finalReport, `${lines.join("\n")}\n`);
  st.project = { status: "done", finished_at: nowIso() };
  ev(e, { type: "project.done", data: {} });
  persist(e);
  try {
    commitAll(e.root, "looprch: project complete");
  } catch (err) {
    return block(e, (err as LrError).code ?? "hook_failed", errorMessage(err), (err as LrError).hint ?? "");
  }
  return { ...base(e, "Project complete"), action: "project_done", report: ".looprch/FINAL_REPORT.md" };
}

// ---------------------------------------------------------------------------------------------
// side runs: /lr-worker and /lr-review (never change the phase lifecycle)

export function issueSideRun(e: Engine, kind: "worker" | "adhoc_review", opts: { question?: string; phase?: string }): RunRoleAction {
  const st = e.st;
  const role: Role = kind === "worker" ? "worker" : "reviewer";
  const list = assignments(e, role);
  if (kind === "worker") {
    const max = e.cfg.roles.worker?.max_parallel ?? 3;
    const active = Object.values(st.runs_index).filter((r) => r.side && r.role === "worker" && (r.status === "issued" || r.status === "running")).length;
    if (active >= max) throw new LrError("worker_limit", `${active} Worker run(s) are already active (max_parallel ${max})`, "Wait for one to finish (looprch dispatch --wait <run_id>) or raise roles.worker.max_parallel");
  }
  let chosen: Assignment | null = null;
  let effective: "direct" | "delegate" = "delegate";
  let reason: ModeReason = "configured";
  for (let i = 0; i < list.length && !chosen; i++) {
    const a = list[i]!;
    const m = resolveMode(e.root, a, e.host);
    if (!m.ok) throw new LrError(m.code, `${role}: ${m.reason}`, m.hint);
    const q = quotaChoice(e, a);
    if (q.kind === "attempt") {
      chosen = a;
      effective = m.mode;
      reason = m.reason === "d05_auto_delegate" ? "d05_auto_delegate" : i > 0 ? "quota_fallback" : "configured";
    } else if (q.kind === "wait" || i === list.length - 1) throw new LrError("quota_wait", `${role} cannot run now: ${q.reason}`, "Try again after the reset");
  }
  const phaseId = kind === "adhoc_review" ? (opts.phase ?? st.current?.phase ?? null) : (st.current?.phase ?? null);
  if (kind === "adhoc_review" && !phaseId) throw new LrError("no_phase", "Name the phase to review: looprch review P-NNN");
  const phase = phaseId ? phaseDef(e, phaseId) : null;
  const runsDir = projectPaths(e.root).runs;
  const stamp = nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runId = kind === "worker" ? `${phaseId ?? "PROJECT"}-worker-${readdirSafe(runsDir).filter((d) => d.startsWith(`${phaseId ?? "PROJECT"}-worker-`)).length + 1}` : `${phaseId}-reviewer-adhoc-${stamp}`;
  const inputs: { path: string; why: string }[] = [];
  let packet: Packet | null = null;
  if (kind === "adhoc_review" && phase) {
    packet = buildPacket(e.root, phase.id, "reviewer");
    for (const n of ["plan.md", "handover.md", "gates.json", "test-report.md", "review.md"]) {
      const p = join(projectPaths(e.root).phase(phase.id), n);
      if (existsSync(p)) inputs.push({ path: rel(e, p), why: `phase ${n}` });
    }
    const rec = st.phases[phase.id];
    const diff = rec?.status === "closed" && rec.tag ? gitOk(e.root, ["diff", `${rec.tag}^1`, rec.tag]) : st.current?.phase === phase.id && st.current.phase_base ? gitOk(e.root, ["diff", st.current.phase_base]) : "";
    const diffPath = join(projectPaths(e.root).run(runId), "diff.patch");
    writeFileAtomic(diffPath, diff);
    inputs.push({ path: rel(e, diffPath), why: rec?.status === "closed" ? `git diff ${rec.tag}^1 ${rec.tag} (the closed phase)` : "git diff since the phase base" });
  } else if (phase) inputs.push(...closedHandovers(e, phase));
  const brief = assembleBrief({
    root: e.root,
    runId,
    role,
    task: kind,
    stage: kind,
    phase: phaseId ?? "PROJECT",
    phaseTitle: phase?.title ?? e.manifest.project.title,
    phaseBase: st.current?.phase === phaseId ? (st.current?.phase_base ?? null) : null,
    packet: packet ? { path: packet.path, bytes: packet.bytes } : null,
    phaseSource: phase?.en ?? null,
    inputs,
    delta: null,
    userNote: null,
    resume: false,
    question: opts.question,
    gateIds: phase?.gates.map((g) => g.id) ?? [],
    readOnly: true,
  });
  const run: RunRecord = {
    run_id: runId,
    phase: phaseId,
    stage: kind,
    task: kind,
    role,
    mode: chosen!.mode,
    effective_mode: effective,
    mode_reason: reason,
    agent: chosen!.agent,
    model: chosen!.model,
    effort: chosen!.effort ?? null,
    timeout: chosen!.timeout ?? "30m",
    session_in: null,
    resume: false,
    attempt: 1,
    status: "issued",
    side: true,
    read_only: true,
    packet: packet?.path ?? null,
    brief: writeBrief(e.root, runId, brief),
    pid: null,
    relay_path: null,
    relay_sha256: null,
    argv: null,
    started_at: nowIso(),
    finished_at: null,
    git_before: snapshotTree(e.root),
    git_after: null,
    touched_files: [],
    session_out: null,
    decision: null,
    ...(opts.question ? { question: opts.question } : {}),
  };
  saveRun(e.root, run);
  st.runs_index[runId] = { role, status: "issued", attempt: 1, side: true };
  ev(e, { type: "run.issued", role, agent: run.agent, run_id: runId, data: { task: kind, side: true, mode: effective, model: run.model } });
  return runRoleAction(e, run);
}

// ---------------------------------------------------------------------------------------------
// user commands: answer, pause, resume

export function answer(e: Engine, qid: string, option: string, text: string | null): string {
  const q = e.st.pending_question;
  if (!q || q.id !== qid) throw new LrError("no_such_question", `No pending question ${qid}${q ? ` (pending: ${q.id})` : ""}`);
  if (!q.options.some((o) => o.id === option)) throw new LrError("invalid_option", `Option must be one of ${q.options.map((o) => o.id).join(", ")}`, undefined, 2);
  e.st.pending_question = null;
  e.st.answers[qid] = option;
  ev(e, { type: "question.answered", data: { id: qid, option, text } });
  switch (q.kind) {
    case "commit_baseline":
    case "approve_merge":
    case "host_conflict":
      break;
    case "ack_gates":
      if (option === "acknowledge") {
        e.cfg.spec.gates_ack = { manifest_sha256: String(q.context.manifest_sha256), acknowledged_at: nowIso(), commands: [] };
        saveConfigFromEngine(e);
        ev(e, { type: "init.gates_acknowledged", data: { manifest_sha256: q.context.manifest_sha256 } });
      } else e.st.flags.paused = { reason: "gate commands not acknowledged", at: nowIso() };
      break;
    case "approve_plan":
      if (option === "revise") {
        const c = cur(e);
        c.deltas.planner = { kind: "revise", text: `The user asked for these changes: ${text ?? "(no text given; ask what to change in your report)"}` };
        transition(e, "synthesizing");
      }
      break;
    case "context_over_budget": {
      const c = cur(e);
      const key = String(q.context.key);
      if (option === "continue") c.context_ok.push(key);
      else {
        const role = String(q.context.role) as Role;
        const n = Number(q.context.fallback);
        const list = assignments(e, role);
        recordAssignment(e, role, list[c.assignment_index[role] ?? 0]!, list[n]!, "user_choice", null);
        c.assignment_index[role] = n;
      }
      break;
    }
    case "rate_limit_long":
      if (option === "keep_waiting") e.st.quota.rate_limit_wait_started = nowIso();
      else e.st.flags.paused = { reason: "paused after a long rate limit", at: nowIso() };
      break;
    case "final_review":
      answerFinalReview(e, qid, option);
      break;
    case "debate_unresolved":
      answerDebateUnresolved(e, qid, option, (q.context.items as string[] | undefined) ?? []);
      break;
    default: {
      const never: never = q.kind;
      throw new LrError("internal", `unhandled question ${String(never)}`);
    }
  }
  return option;
}

function saveConfigFromEngine(e: Engine): void {
  writeFileAtomic(projectPaths(e.root).config, `${JSON.stringify(e.cfg, null, 2)}\n`);
}

export function pause(e: Engine): void {
  e.st.flags.pause_requested = true;
}

/** Plan files of an open protocol-4 (Looprch 0.7) phase, moved to v07/ when it restarts at planning. */
const V07_FILES = /^(contract|plan|debate|readback|design-debate|traceability|changed-files|incoming-deferrals|review|test-report)([.-].*)?$|^blueprints$/;

/**
 * An open phase that started under protocol 4 restarts at planning under the new protocol: its
 * contract, plan and debate files move to v07/, the code it already wrote stays on the branch.
 */
function restartForProtocol(e: Engine): void {
  const st = e.st;
  const c = st.current;
  if (!c || st.protocol >= 5 || c.stage === "preflight" || c.stage === "closing") return;
  const dir = projectPaths(e.root).phase(c.phase);
  const archive = join(dir, "v07");
  ensureDir(archive);
  for (const f of readdirSafe(dir)) if (V07_FILES.test(f)) renameSync(join(dir, f), join(archive, f));
  const fresh = newCurrent(c.phase, c.title, nowIso());
  st.current = { ...fresh, stage: "planning", phase_base: c.phase_base, branch: c.branch, last_commit: c.last_commit, run_seq: c.run_seq, assignment_index: c.assignment_index, last_agent: c.last_agent };
  if (st.pending_question && !(QUESTION_KINDS as readonly string[]).includes(st.pending_question.kind)) st.pending_question = null;
  ev(e, { type: "stage.entered", stage: "planning", data: { round: 0, restarted_from: c.stage, archive: rel(e, archive) } });
}

export function resume(e: Engine, note: string | null): string[] {
  const st = e.st;
  const cleared: string[] = [];
  if (st.flags.blocked) {
    const code = st.flags.blocked.code;
    if (code === "spec_changed") {
      const v = verifyPackage(e.root);
      if (!v.ok) throw new LrError("spec_changed", "The package still does not verify", "Reseal an authorized amendment with SEV3, then run looprch init discover --accept-fingerprint");
    }
    if (code === "repair_limit" && st.current) st.current.extra_rounds++;
    if (code === "expansion_limit" && st.current) st.current.expansion_round = Math.max(0, st.current.expansion_round - 1);
    if (code === "result_invalid" && st.current) st.current.reask_count = 0;
    if ((code === "run_failed" || code === "cli_missing") && st.current) for (const k of Object.keys(st.current.attempts)) st.current.attempts[k] = 0;
    st.flags.blocked = null;
    cleared.push("blocked");
  }
  if (st.flags.paused) {
    if (st.flags.paused.reason.startsWith("protocol_changed")) {
      restartForProtocol(e);
      markPhaseStart(st);
    }
    st.flags.paused = null;
    cleared.push("paused");
  }
  st.flags.pause_requested = false;
  if (st.flags.waiting) {
    st.flags.waiting = null;
    cleared.push("waiting");
  }
  if (note && st.current) st.current.user_note = note;
  ev(e, { type: "resumed", data: { cleared, note } });
  return cleared;
}

export function nextDescription(st: State): string {
  const c = st.current;
  if (st.flags.blocked) return `blocked: ${st.flags.blocked.reason}`;
  if (st.pending_question) return `waiting for your answer: ${st.pending_question.question}`;
  if (st.flags.paused) return `paused: ${st.flags.paused.reason}`;
  if (st.flags.waiting) return `waiting until ${st.flags.waiting.until}`;
  if (st.pending_checkpoint) return `checkpoint commit: ${st.pending_checkpoint.label}`;
  if (!c) return st.project.status === "done" ? "project complete" : "start the next phase (/lr-phase or /lr-auto)";
  if (c.active_run) return `finish run ${c.active_run}`;
  const map: Record<Stage, string> = {
    preflight: "preflight checks",
    planning: "Planner writes the plan",
    debating: "Plan Debater reviews the plan",
    synthesizing: "Planner finalizes the plan",
    plan_approval: "plan approval",
    implementing: c.sessions && c.sessions.length > 1 ? `Implementer works on session ${(c.session_index ?? 0) + 1} of ${c.sessions.length}` : "Implementer implements the plan",
    testing: "Tester writes tests",
    gating: "run gates after the tester report",
    reviewing: "Reviewer reviews code and evidence",
    repairing: "Implementer repairs findings",
    handover: "Implementer writes the handover",
    closing: "tick todo.md, commit, merge and tag",
  };
  return map[c.stage];
}
