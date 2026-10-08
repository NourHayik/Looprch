import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, PROTOCOL, READ_ONLY_ROLES, type Role } from "./constants.js";
import type { AgentId, Approval, Assignment, Config } from "./config.js";
import { loadConfig, reviewRounds } from "./config.js";
import type { Action, RunRoleAction } from "./actions.js";
import { assembleBrief, writeBrief, type Task } from "./briefs.js";
import { now, nowIso, reviewTimeout } from "./clock.js";
import { LrError, errorMessage } from "./errors.js";
import { ensureDir, writeFileAtomic } from "./fsx.js";
import { appendEvent, type EventInput } from "./journal.js";
import { resolveMode, type ModeReason } from "./mode.js";
import { projectPaths } from "./paths.js";
import { preflightChecks } from "./preflight.js";
import { extractResultBlock, validateResult, type ExpansionRequest, type RoleResult } from "./results.js";
import { loadRun, relayOutDir, saveRun, type RunRecord, type RunStatus } from "./runs.js";
import { loadState, markPhaseStart, newCurrent, saveState, type AssignmentChange, type Delta, type DesignState, type Finding, type LedgerEntry, type QuestionKind, type Scope, type Stage, type State, type Verification } from "./state.js";
import { amend, contractIds, contractProblems, dispositionProblems, incomingDeferrals, loadContract, newContract, orderWork, repairPackageProblems, saveContract, unresolvedByAmendment, WORK_LIMITS, type Contract, type WorkItem } from "./contract.js";
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
import { loadGates, staleClaims, testcaseIndex, unbackedTests, type GatesOutcome } from "../gates/runner.js";

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
    st.flags.paused = { reason: `protocol_changed: this phase started with protocol ${st.protocol}; this Looprch uses protocol ${PROTOCOL}. Run looprch resume to continue with the new protocol.`, at: nowIso() };
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
    case "debating":
      return issueRun(e, "plan_debater", "debate");
    case "synthesizing":
      return issueRun(e, "planner", c.deltas.planner?.kind === "revise" ? "revise" : "synthesis");
    case "plan_approval": {
      if (approvalApplies(e.cfg.approvals.plan, phase)) {
        const qid = `approve_plan-${c.phase}-r${c.round}-${readdirSafe(projectPaths(e.root).phase(c.phase)).filter((f) => f.startsWith("plan.r")).length}`;
        const ans = st.answers[qid];
        if (!ans) return ask(e, "approve_plan", qid, `Approve the plan for ${c.phase} "${c.title}"? Read .looprch/phases/${c.phase}/plan.md first.`, [{ id: "approve", label: "Approve and implement" }, { id: "revise", label: "Ask the Planner to revise (add --text)" }]);
      }
      st.pending_checkpoint = { label: "plan approved" };
      const wps = loadContract(e.root, c.phase)?.work_packages;
      const ordered = wps?.length ? orderWork(wps) : null;
      c.work = ordered ? { kind: "implementation", items: ordered, done: [] } : null;
      transition(e, "implementing");
      return null;
    }
    case "implementing":
    case "repairing":
      if (c.design) return issueRun(e, c.design.step === "debate" ? "plan_debater" : "planner", c.design.step === "debate" ? "design_review" : "context_answer");
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

function runInputs(e: Engine, role: Role, task: Task, phase: PhaseDef): { path: string; why: string }[] {
  const c = cur(e);
  const list: [string, string][] = [];
  const plan: [string, string] = ["plan.md", "approved implementation plan"];
  const contract: [string, string] = ["contract.json", "the phase contract: binding obligations (rule, enforcement point, what proves it) and deferrals"];
  switch (task) {
    case "planning":
      break;
    case "debate":
      list.push(["plan.md", "the plan to review"], ["contract.json", "the plan's contract (obligations and deferrals) to challenge"]);
      break;
    case "synthesis":
      list.push(["plan.md", "your plan"], ["contract.json", "your contract"], ["debate.md", "the single Plan Debate pass"]);
      break;
    case "revise":
      list.push(["plan.md", "the current plan"], ["contract.json", "the current contract"]);
      break;
    case "context_answer":
      list.push(["plan.md", "the current plan"], ["contract.json", "the current contract"]);
      if (c.design) list.push(["review.md", "the review whose findings need a repair design"]);
      if (c.design?.step === "revise") list.push([`design-debate-${c.addenda.length}.md`, "the Plan Debater's challenge of your repair design"]);
      break;
    case "design_review":
      list.push(["plan.md", "the approved plan"], ["contract.json", "the contract including the proposed amendment"], ["review.md", "the review findings the design answers"]);
      break;
    case "implementation":
      list.push(plan, contract);
      break;
    case "repair":
      list.push(plan, contract, ["test-report.md", "latest test report"], ["gates.json", "machine evidence from Looprch's gate runs"]);
      if (c.repair_source === "review") list.push(["review.md", "review findings to address"]);
      break;
    case "testing":
      list.push(plan, contract);
      if (c.round > 0) list.push(["gates.json", "earlier gate runs"]);
      if (c.repair_source === "review") list.push(["review.md", "review findings to verify"]);
      break;
    case "review":
      list.push(plan, contract, ["test-report.md", "Tester report"], ["gates.json", "machine evidence (bound to the reviewed snapshot)"]);
      break;
    case "handover":
      list.push(plan, contract, ["gates.json", "final gate runs"], ["test-report.md", "Tester report"], ["review.md", "Reviewer report"]);
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
      out.push({ path: rel(e, path), why: `deferrals that closed phases made to ${c.phase}; the contract must cover each one (list its ref in "covers") or defer it again` });
    }
  }
  if (task === "testing" || task === "review")
    for (const p of c.repair_reports ?? []) out.push({ path: p, why: "Implementer repair report: how each finding was fixed (resolutions, limitations)" });
  for (const a of c.addenda) out.push({ path: a, why: "Planner addendum (context answer or repair design); binding for this phase" });
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
  const inputs = runInputs(e, role, task, phase);
  const item = role === "implementer" && (task === "implementation" || task === "repair") ? currentWorkItem(c) : null;
  const delta = item ? workDelta(c, c.deltas[role] ?? null, item) : (c.deltas[role] ?? null);
  if (delta?.kind === "switch" && c.phase_base) {
    const diffPath = join(projectPaths(e.root).run(runId), "diff.patch");
    writeFileAtomic(diffPath, gitOk(e.root, ["diff", c.phase_base, "HEAD"]));
    inputs.push({ path: rel(e, diffPath), why: "diff of this phase since its base (work so far)" });
    for (const r of previousFinals(e, role)) inputs.push({ path: r, why: "an earlier final message for this role" });
  }
  const readOnly = READ_ONLY_ROLES.includes(role);
  const baseTimeout = chosen.timeout ?? e.cfg.roles[role]?.timeout ?? "60m";
  const reviewN = task === "review" ? (c.review_changes ?? 0) + 1 : 0;
  const timeout = task === "review" ? reviewTimeout(baseTimeout, reviewN) : baseTimeout;
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
    ...(task === "review" ? { reviewRound: { n: reviewN, of: reviewCap(e), tree: c.snapshots.gates, prevTree: reviewN > 1 ? (c.reviewed_tree ?? null) : null, timeout } } : {}),
  });
  const briefPath = writeBrief(e.root, runId, brief);
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
    git_before: snapshotTree(e.root),
    git_after: null,
    touched_files: [],
    session_out: null,
    decision: null,
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
    data: { task, mode: effective!, mode_reason: modeReason, model: chosen.model, session: sessionId, packet_bytes: packet?.bytes ?? null, attempt, timeout, ...(reviewN ? { review_round: reviewN, review_cap: reviewCap(e) } : {}) },
  });
  if (modeReason === "d05_auto_delegate") ev(e, { type: "mode.auto_delegate", role, agent: chosen.agent, run_id: runId, data: { host: e.host } });
  return runRoleAction(e, run);
}

/** The next package of the work queue, or null when there is none (or no queue). */
function currentWorkItem(c: NonNullable<State["current"]>): WorkItem | null {
  return c.work?.items.find((w) => !c.work!.done.includes(w.id)) ?? null;
}

/** The Implementer's delta for one package: the package rendered as literal instructions, plus the round's findings it repairs. */
function workDelta(c: NonNullable<State["current"]>, base: Delta | null, item: WorkItem): Delta {
  const work = c.work!;
  const n = work.items.findIndex((w) => w.id === item.id) + 1;
  const what = work.kind === "implementation" ? "Work package" : "Repair package";
  const lines = [
    `## ${what} ${item.id} (${n} of ${work.items.length}): ${item.title}`,
    "",
    `Implement exactly this package and nothing else; the other packages run separately${work.done.length ? ` (done: ${work.done.join(", ")})` : ""}. Follow the steps in order and literally. If a step is ambiguous, contradicts the code or the contract, or needs a decision the package does not make, do not guess: return needs_context (or needs_design for a finding) and say which step. Report "work_package": "${item.id}" in the result block.`,
    "",
    ...(item.obligations?.length ? [`Obligations: ${item.obligations.join(", ")}`] : []),
    ...(item.findings?.length ? [`Findings: ${item.findings.join(", ")}`] : []),
    "Files:",
    ...item.files.map((f) => `- ${f.action} \`${f.path}\`: ${f.content}`),
    "Steps:",
    ...item.steps.map((s, i) => `${i + 1}. ${s}`),
    "Done when (check each yourself before you report implemented):",
    ...item.done_when.map((d) => `- ${d}`),
  ];
  const own = new Set(item.findings ?? []);
  const findings = item.findings ? (base?.findings ?? []).filter((f) => own.has(f.id)) : base?.findings;
  const text = base?.text ? `${base.text}\n\n${lines.join("\n")}` : lines.join("\n");
  return { ...(base ?? {}), kind: base?.kind ?? "repair", text: item.findings ? text.replace(/Report `resolutions` for: [^\n]*/, `Report \`resolutions\` for: ${item.findings.join(", ")}.`) : text, ...(findings ? { findings } : {}) };
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
  design_review: ["findings", "no_findings"],
  implementation: ["implemented", "needs_context"],
  repair: ["implemented", "needs_context"],
  handover: ["handover_ready"],
  testing: ["pass", "fail"],
  review: ["approve", "changes_requested"],
  adhoc_review: ["approve", "changes_requested"],
  worker: ["answered"],
};

export function acceptResult(e: Engine, run: RunRecord, finalMessage: string, sessionId: string | null, readOnlyViolation = false): AcceptOutcome {
  const st = e.st;
  run.finished_at = nowIso();
  run.session_out = sessionId;
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
  if (run.read_only && (readOnlyViolation || run.touched_files.length)) {
    finish("rejected");
    ev(e, { type: "readonly.violation", role: run.role, agent: run.agent, run_id: run.run_id, data: { files: run.touched_files, relay_flag: readOnlyViolation } });
    if (!run.side) block(e, "readonly_violation", `The read-only ${run.role} run changed files: ${run.touched_files.join(", ") || "(reported by the relay)"}`, "Looprch never reverts files. Review and undo the changes yourself, then run looprch resume.", { files: run.touched_files });
    return { status: "rejected", decision: null, artifact: null, errors: ["read-only violation"] };
  }
  const ex = extractResultBlock(finalMessage);
  let errors: string[] = [];
  let result: RoleResult | null = null;
  if (!ex.ok) errors = [ex.error!];
  else {
    const v = validateResult(run.role, ex.json, run.run_id);
    if (!v.ok) errors = v.errors;
    else if (!TASK_DECISIONS[run.task].includes(v.result.decision)) errors = [`decision "${v.result.decision}" is not valid for this task; use one of ${TASK_DECISIONS[run.task].join(", ")}`];
    else result = v.result;
  }
  if (result && !run.side) {
    const why = phaseRuleViolation(e, run, result, ex.artifact);
    if (why) {
      errors = [why];
      result = null;
    }
  }
  if (!result) {
    finish("rejected");
    ev(e, { type: "result.rejected", role: run.role, agent: run.agent, run_id: run.run_id, data: { errors } });
    if (run.side) return { status: "rejected", decision: null, artifact: null, errors };
    const c = cur(e);
    if (c.reask_count < 1) {
      c.reask_count++;
      c.deltas[run.role] = { ...(c.deltas[run.role] ?? {}), kind: "reask", text: `Your previous final message was rejected: ${errors.join("; ")}. Reply again with your complete report and exactly one valid looprch-result block at the end.${c.deltas[run.role]?.text ? `\n\nEarlier instructions still apply:\n${c.deltas[run.role]!.text}` : ""}` };
      ev(e, { type: "run.reask", role: run.role, agent: run.agent, run_id: run.run_id, data: { errors } });
      return { status: "reask", decision: null, artifact: null, errors };
    }
    block(e, "result_invalid", `${run.role} did not return a valid result block twice: ${errors.join("; ")}`, `See .looprch/runs/${run.run_id}/final.md, then run looprch resume to try again`);
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
      findings_total: reported.length,
      severities: severityCounts(reported),
      findings: reported.map((f) => ({
        id: f.id,
        ...(f.severity ? { severity: f.severity } : {}),
        ...(f.owner ? { owner: f.owner } : {}),
        ...(f.origin ? { origin: f.origin } : {}),
        ...("cause" in f && f.cause ? { cause: f.cause } : {}),
        ...("related" in f && f.related ? { related: f.related } : {}),
        ...("obligations" in f && f.obligations?.length ? { obligations: f.obligations } : {}),
        summary: f.summary.slice(0, 300),
      })),
      ...(run.task === "review" && !run.side ? { review_round: (st.current?.review_changes ?? 0) + 1, review_cap: reviewCap(e) } : {}),
      ...(result.resolutions ? { resolutions: result.resolutions.map((r) => ({ id: r.id, status: r.status, ...(r.files ? { files: r.files.length } : {}) })) } : {}),
      ...(result.verifications ? { verifications: result.verifications.map((v) => ({ id: v.id, status: v.status, tests: v.tests.length, variants: v.variants.length })) } : {}),
      ...(result.prior ? { prior: result.prior.map((p) => ({ id: p.id, status: p.status })) } : {}),
      ...(result.contract_review ? { contract_unmet: result.contract_review.filter((x) => x.status === "not_met").map((x) => x.id) } : {}),
      ...(result.debate_dispositions ? { dispositions: result.debate_dispositions.map((d) => ({ id: d.id, decision: d.decision })) } : {}),
    },
  });
  if (run.side) return { status: "accepted", decision: result.decision, artifact: writeSideOutput(e, run, ex.artifact, result), errors: [] };
  const c = cur(e);
  c.reask_count = 0;
  c.attempts[run.role] = 0;
  const priorDelta = c.deltas[run.role];
  delete c.deltas[run.role];
  const artifact = applyResult(e, run, result, ex.artifact, priorDelta ?? null);
  return { status: "accepted", decision: result.decision, artifact, errors: [] };
}

function contractContext(e: Engine) {
  const c = cur(e);
  return { phase: phaseDef(e, c.phase), manifest: e.manifest, incoming: incomingDeferrals(e.root, e.manifest, e.st, c.phase) };
}

function obligationOf(contract: Contract | null, id: string) {
  return contract?.obligations.find((o) => o.id === id) ?? null;
}

const TEST_GATE_KINDS = new Set(["test", "integration"]);
/** gate_id of the problems Looprch raises when a Tester claim is not backed by the gate evidence. */
const EVIDENCE_GATE = "evidence-binding";

/** An obligation the Tester may mark `inspected`: procedural, or proven only by non-test gates. */
function inspectable(e: Engine, contract: Contract | null, id: string): boolean {
  if (contract?.deferrals.some((d) => d.id === id)) return true;
  const o = obligationOf(contract, id);
  if (!o) return false;
  if (o.kind === "procedure") return true;
  const gates = phaseDef(e, cur(e).phase).gates;
  return o.gates.every((g) => !TEST_GATE_KINDS.has(gates.find((x) => x.id === g)?.kind ?? "test"));
}

function joinProblems(list: string[]): string | null {
  return list.length ? list.join("; ") : null;
}

/**
 * Checks that need the phase state: the contract covers the phase, debate findings are
 * dispositioned, resolutions and verifications cover their findings and match the diff and the
 * contract, reviews cover the contract and stay consistent with earlier findings.
 */
function phaseRuleViolation(e: Engine, run: RunRecord, r: RoleResult, artifact: string): string | null {
  const c = e.st.current;
  if (!c) return null;
  const contract = loadContract(e.root, c.phase);
  const problems: string[] = [];
  switch (run.task) {
    case "planning":
    case "synthesis":
    case "revise": {
      if (!r.contract) break;
      problems.push(...contractProblems(r.contract, contractContext(e)));
      if (run.task === "synthesis") problems.push(...dispositionProblems(r.debate_dispositions, c.debate_findings ?? [], r.contract));
      break;
    }
    case "context_answer": {
      const building = c.work?.kind === "implementation" && !c.design;
      if (contract && r.contract_amendment)
        problems.push(...contractProblems(amend(contract, r.contract_amendment), contractContext(e), { amended: !building }).map((p) => `after the amendment: ${p}${building ? " (during implementation, a new obligation needs a work package in contract_amendment.work_packages)" : ""}`));
      if (c.design) {
        problems.push(...repairPackageProblems(r.repair_packages, c.design.findings));
        const mustAmend = c.design.amend ?? c.design.findings;
        if (mustAmend.length && !r.contract_amendment)
          problems.push(`the design must amend the contract for ${mustAmend.join(", ")}: return "contract_amendment" with the obligations (or deferrals) that define each repair, each listing the finding ids it answers in "resolves"`);
        const open = unresolvedByAmendment(r.contract_amendment, mustAmend);
        if (r.contract_amendment && open.length) problems.push(`every finding the design amends the contract for needs an amended obligation or deferral that lists it in "resolves"; missing: ${open.join(", ")}`);
      }
      break;
    }
    case "implementation":
    case "repair": {
      const item = currentWorkItem(c);
      if (item && r.decision === "implemented" && r.work_package !== item.id) problems.push(`report "work_package": "${item.id}" (the package this run implemented)`);
      if (run.task !== "repair" || r.decision !== "implemented" || c.repair_source !== "review") break;
      const got = new Map((r.resolutions ?? []).map((x) => [x.id, x]));
      const assigned = item?.findings ?? (c.deltas.implementer?.findings ?? []).map((f) => f.id);
      const missing = assigned.filter((id) => !got.has(id));
      if (missing.length) problems.push(`resolutions must list every finding assigned to you ({"id","status":"fixed|not_fixed|needs_design","note","files"}); missing: ${missing.join(", ")}`);
      if (c.reviewed_tree) {
        const changed = new Set(changedBetween(e.root, c.reviewed_tree, snapshotTree(e.root)));
        const norm = (p: string) => (p.startsWith(`${e.root}/`) ? p.slice(e.root.length + 1) : p).replace(/^\.\//, "");
        const unchanged = (r.resolutions ?? []).filter((x) => x.status === "fixed" && !(x.files ?? []).some((f) => changed.has(norm(f)))).map((x) => x.id);
        if (unchanged.length) problems.push(`these resolutions say fixed, but none of their files changed since the review: ${unchanged.join(", ")}. List the files your repair changed, or report not_fixed`);
      }
      break;
    }
    case "testing": {
      const verifs = r.verifications ?? [];
      const byId = new Map(verifs.map((v) => [v.id, v]));
      const failed = verifs.filter((v) => v.status === "failed").map((v) => v.id);
      if (r.decision === "pass" && failed.length) problems.push(`decision pass with failed verifications (${failed.join(", ")}): return fail and list them in failures`);
      if (contract) {
        const known = new Set((c.tester_verifications ?? []).map((v) => v.id));
        const uncovered = contractIds(contract).filter((id) => !byId.has(id) && !known.has(id));
        if (uncovered.length) problems.push(`verifications must cover every contract obligation and deferral ({"id","status":"verified|failed|inspected","tests":[testcase names],"variants":[]}); missing: ${uncovered.slice(0, 30).join(", ")}${uncovered.length > 30 ? ` and ${uncovered.length - 30} more` : ""}`);
      }
      const assigned = (c.deltas.tester?.findings ?? []).filter((f) => c.repair_source === "review" || f.gate_id === EVIDENCE_GATE);
      const unverified = assigned.map((f) => f.id).filter((id) => !byId.has(id));
      if (unverified.length) problems.push(`verifications must list every review finding in the Delta; missing: ${unverified.join(", ")}`);
      for (const f of assigned) {
        const v = byId.get(f.id);
        if (!v) continue;
        const serious = f.severity === "high" || f.severity === "critical";
        if (v.status === "verified" && serious && !v.variants.length) problems.push(`${f.id} is ${f.severity}: list the variants you tested beyond the Reviewer's example in "variants"`);
        if (v.status === "inspected" && serious) problems.push(`${f.id} is ${f.severity}: verify it with a test (status verified with tests), not by inspection`);
      }
      for (const v of verifs) {
        if (v.status !== "inspected" || assigned.some((f) => f.id === v.id)) continue;
        if (contract && contractIds(contract).includes(v.id) && !inspectable(e, contract, v.id)) problems.push(`${v.id} is checked by a test gate: verify it with a test, not by inspection`);
      }
      break;
    }
    case "review": {
      const n = (c.review_changes ?? 0) + 1;
      if (!/^#{1,3}\s*Coverage\b/m.test(artifact)) problems.push("the review report must start with a ## Coverage section");
      const findings = r.findings ?? [];
      const ids = new Set(contractIds(contract));
      for (const f of findings) {
        const bad = (f.obligations ?? []).filter((o) => !ids.has(o));
        if (contract && bad.length) problems.push(`${f.id}: obligations ${bad.join(", ")} are not in contract.json`);
      }
      if (contract && n === 1) {
        const reviewed = new Map((r.contract_review ?? []).map((x) => [x.id, x.status]));
        const missing = [...ids].filter((id) => !reviewed.has(id));
        if (missing.length) problems.push(`contract_review must give met or not_met for every obligation and deferral in contract.json; missing: ${missing.slice(0, 30).join(", ")}${missing.length > 30 ? ` and ${missing.length - 30} more` : ""}`);
        const cited = new Set(findings.flatMap((f) => f.obligations ?? []));
        const orphan = [...reviewed].filter(([id, s]) => s === "not_met" && !cited.has(id)).map(([id]) => id);
        if (orphan.length) problems.push(`every not_met obligation needs a finding that lists it in "obligations": ${orphan.join(", ")}`);
      }
      problems.push(...rereviewProblems(c, r));
      if (r.decision === "changes_requested" && n >= reviewCap(e) && !findings.some((f) => f.severity === "high" || f.severity === "critical"))
        problems.push("this is the final review: changes_requested needs a high or critical finding; approve and keep the medium and low findings in findings");
      break;
    }
    default:
      break;
  }
  return joinProblems(problems);
}

/** A re-review states fixed/unfixed for every earlier finding; ids and origins must agree with that. */
function rereviewProblems(c: NonNullable<State["current"]>, r: RoleResult): string[] {
  const ledger = c.finding_ledger ?? {};
  const findings = r.findings ?? [];
  const problems: string[] = [];
  for (const f of findings) if (f.related && !ledger[f.related]) problems.push(`${f.id}: related ${f.related} is not an earlier finding of this phase`);
  const delta = (c.review_changes ?? 0) > 0 ? c.review_findings : [];
  if (!delta.length) {
    const reused = findings.filter((f) => ledger[f.id]).map((f) => f.id);
    if (reused.length) problems.push(`ids ${reused.join(", ")} were used by an earlier review; give new findings new ids (with "related" when they concern the same rule)`);
    return problems;
  }
  const prior = new Map((r.prior ?? []).map((p) => [p.id, p.status]));
  const missing = delta.map((f) => f.id).filter((id) => !prior.has(id));
  if (missing.length) problems.push(`a re-review lists every earlier finding in "prior" ({"id","status":"fixed|unfixed"}); missing: ${missing.join(", ")}`);
  const open = new Set(delta.map((f) => f.id));
  for (const f of findings) {
    if (open.has(f.id)) {
      if (f.origin !== "unfixed") problems.push(`${f.id} is an earlier finding: report it only as origin unfixed (a new way to break the rule gets a new id with "related": "${f.id}")`);
      else if (prior.get(f.id) !== "unfixed") problems.push(`${f.id} has origin unfixed, so prior must say unfixed for it`);
    } else if (ledger[f.id]) problems.push(`${f.id} was used by an earlier review; use a new id with "related": "${f.id}" and origin regression or missed`);
    else if (f.origin === "unfixed") problems.push(`${f.id} has origin unfixed but is not an earlier finding; use regression or missed`);
    else if (!f.origin) problems.push(`${f.id}: a re-review sets origin regression or missed on new findings`);
  }
  for (const [id, s] of prior) if (s === "unfixed" && !findings.some((f) => f.id === id)) problems.push(`prior says ${id} is unfixed: report it in findings with origin unfixed`);
  return problems;
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

const DESIGN_CAUSES = new Set(["plan", "requirement", "cross_phase"]);

function lineageOf(c: NonNullable<State["current"]>, id: string): string {
  return c.finding_ledger?.[id]?.lineage ?? id;
}

function lineageEntries(c: NonNullable<State["current"]>, lineage: string): LedgerEntry[] {
  return Object.values(c.finding_ledger ?? {}).filter((l) => l.lineage === lineage);
}

/** Record review findings in the phase ledger: lineages, rounds, reports; an unfixed finding keeps its first Fix. */
function updateLedger(e: Engine, findings: Finding[], prior: { id: string; status: string }[]): void {
  const c = cur(e);
  const ledger = (c.finding_ledger ??= {});
  const round = (c.review_changes ?? 0) + 1;
  for (const p of prior) if (ledger[p.id]) ledger[p.id]!.status = p.status === "fixed" ? "fixed" : "open";
  for (const f of findings) {
    const prev = ledger[f.id];
    if (prev) {
      prev.reports++;
      prev.last_round = round;
      prev.status = "open";
      prev.severity = f.severity ?? prev.severity;
      if (f.origin === "unfixed") {
        if (prev.fix) f.fix = prev.fix;
        if (prev.checks?.length) f.checks = prev.checks;
        else if (f.checks?.length) prev.checks = f.checks;
      }
      continue;
    }
    const lineage = f.related && ledger[f.related] ? ledger[f.related]!.lineage : f.id;
    ledger[f.id] = { lineage, severity: f.severity ?? null, cause: f.cause ?? null, owner: f.owner ?? null, fix: f.fix ?? null, ...(f.checks?.length ? { checks: f.checks } : {}), first_round: round, last_round: round, reports: 1, designs: 0, status: "open" };
  }
}

/** Why an Implementer finding needs a Planner repair design before the Implementer runs, or null. */
function designReason(c: NonNullable<State["current"]>, f: Finding): DesignState["reason"] | null {
  if (f.cause && DESIGN_CAUSES.has(f.cause)) return "plan_cause";
  if (f.origin === "unfixed") return "unfixed";
  if (f.related && lineageEntries(c, lineageOf(c, f.id)).length > 1) return "related";
  return null;
}

/**
 * Open a Planner repair design. The Planner (the expensive model) turns the findings into repair
 * packages the Implementer executes literally, and amends the contract for findings whose correct
 * behavior the contract does not define (design causes, repeated findings, needs_design). The
 * Plan Debater challenges the design once when it amends the contract for a high or critical
 * finding, or replaces a design that did not hold.
 */
export function startDesign(e: Engine, ids: string[], reason: DesignState["reason"], known: Finding[] = []): void {
  const c = cur(e);
  const list = ids.map((id) => c.review_findings.find((f) => f.id === id) ?? known.find((f) => f.id === id) ?? { id, summary: id });
  const redesign = list.filter((f) => lineageEntries(c, lineageOf(c, f.id)).some((l) => l.designs > 0)).map((f) => f.id);
  const amendIds = list.filter((f) => reason === "needs_design" || designReason(c, f) !== null).map((f) => f.id);
  const debate = redesign.length > 0 || list.some((f) => amendIds.includes(f.id) && (f.severity === "high" || f.severity === "critical"));
  c.design = { findings: ids, step: "design", debate, reason, amend: amendIds };
  c.pending_repair_packages = null;
  const why: Record<DesignState["reason"], string> = {
    plan_cause: "some were traced by the Reviewer to the plan or contract (a missing or wrong design decision, a missed requirement, or a cross-phase dependency)",
    unfixed: "some came back after an earlier repair reported them fixed: the Fix condition is still unmet",
    related: "some are new ways to break a rule an earlier finding already reported, so the rule's enforcement is not complete",
    needs_design: "the Implementer reported that the contract does not define how to repair them",
    repair_plan: "the Reviewer requested changes; the Implementer executes your repair packages literally",
    test_repeat: "the same tests or gates failed again after the Implementer's own repair (or the repair limit was reached), so the repair needs your design; the ids below are the Tester's failures and failed gate runs",
  };
  c.deltas.planner = {
    kind: "context_answer",
    text: [
      `Repair design for ${ids.join(", ")}: ${why[reason]}. Do not write code.`,
      `Read the review, the findings' Fix and Check lines, the contract and the current code. Return "repair_packages": small, ordered packages (at most ${WORK_LIMITS.findings} findings and ${WORK_LIMITS.steps} steps each) that a cheaper model can execute literally: the exact files, what each one contains afterwards (classes, functions with signatures, keys, columns), ordered steps that leave no design decision open, and done_when checks the Implementer can run itself. Every finding above is listed in "findings" of a package. Repair the rule at its enforcement point for every Check, not the cited example.`,
      ...(amendIds.length
        ? [`For ${amendIds.join(", ")}, also amend the contract (contract_amendment): add or replace the obligation that defines the correct behavior, with the rule, the requirement behind it, the single enforcement point whose completeness can be checked (an allowlist, one validated path, a structural constraint or a type, never a list of known bad cases), what the Tester must prove, and the gates. Where the full rule needs something a later phase delivers, add a deferral with to_phase and the fail-closed interim behavior. Each amended obligation or deferral lists the finding ids it answers in "resolves".`]
        : []),
      ...(redesign.length ? [`${redesign.join(", ")} already had a repair design that did not hold: do not repeat it; change the enforcement design, make the steps more concrete, or narrow the rule.`] : []),
    ].join("\n"),
    findings: list,
  };
  ev(e, { type: "design.escalated", data: { findings: ids, reason, debate, redesign, amend: amendIds } });
}

/** End a repair design: queue its repair packages for the Implementer (replacing the current package after needs_design). */
function finishDesign(e: Engine): void {
  const c = cur(e);
  const d = c.design;
  if (!d) return;
  if (d.reason === "needs_design") c.designed_this_round = [...new Set([...(c.designed_this_round ?? []), ...d.findings])];
  for (const id of d.amend ?? d.findings) {
    const l = c.finding_ledger?.[id];
    if (l) l.designs++;
  }
  const pkgs = orderWork(c.pending_repair_packages ?? []) ?? [];
  c.pending_repair_packages = null;
  c.design = null;
  if (!pkgs.length) return;
  const active = c.work?.kind === "repair" ? currentWorkItem(c) : null;
  if (c.work && active) {
    const taken = new Set(c.work.items.map((w) => w.id));
    const fresh = pkgs.map((p) => (taken.has(p.id) ? { ...p, id: `${p.id}.${c.work!.done.length + 1}` } : p));
    const i = c.work.items.findIndex((w) => w.id === active.id);
    c.work.items.splice(i, 1, ...fresh);
    c.work.base = c.deltas.implementer ?? c.work.base ?? null;
  } else c.work = { kind: "repair", items: pkgs, done: [], base: c.deltas.implementer ?? null };
}

/**
 * Enter the repair stage with the findings. Review repairs are bounded by the review limit;
 * test/gate repairs by limits.repair_rounds. At that limit it blocks in the repair stage, so
 * `looprch resume` (one extra round) continues with the repair, never with another review.
 * `testerOnly` (claims not backed by gate evidence) sends the round to the Tester alone.
 */
function repairOrBlock(e: Engine, source: "test" | "review", findings: Finding[], paths: string[], summary: string, testerOnly = false): void {
  const c = cur(e);
  c.round++;
  c.repair_source = source;
  c.designed_this_round = [];
  if (source === "test") {
    c.work = null;
    const used = testerOnly ? (c.evidence_rounds ?? 0) : (c.test_repairs ?? 0);
    if (testerOnly) c.evidence_rounds = used + 1;
    else c.test_repairs = used + 1;
    if (testerOnly) {
      delete c.deltas.implementer;
      c.deltas.tester = {
        kind: "repair",
        text: `Round ${c.round}: Looprch checked your verifications against the testcases in its own gate run and could not back the claims below. A verified claim names testcases (as they appear in the JUnit report, or path::name) that exist and pass. Add or fix those tests, or report the verification as failed. Return verifications for: ${findings.map((f) => f.id).join(", ")}.`,
        findings,
      };
      transition(e, "testing");
    } else {
      c.deltas.implementer = { kind: "repair", text: `Repair round ${c.round} (tests/gates failed). Fix every problem below completely, including the same defect anywhere else in the phase diff:`, findings, paths };
      c.deltas.tester = { kind: "repair", text: `Round ${c.round}: the Implementer repaired the problems below. Re-verify, keep the tests honest and update them only where they were wrong.`, findings };
      transition(e, "repairing");
      const keys = [...new Set(findings.flatMap((f) => [f.id, ...(f.gate_id ? [f.gate_id] : [])]))];
      const before = new Set(c.last_test_keys ?? []);
      c.last_test_keys = keys;
      if (findings.some((f) => before.has(f.id) || (f.gate_id && before.has(f.gate_id)))) startDesign(e, findings.map((f) => f.id), "test_repeat", findings);
    }
    if (used >= e.cfg.limits.repair_rounds + c.extra_rounds)
      block(e, "repair_limit", `Repair limit reached (${used} ${testerOnly ? "Tester evidence" : "test/gate repair"} round(s)) with open problems: ${summary}`, 'Decide: run looprch resume --note "<instruction>" for one more round, or raise limits.repair_rounds with looprch config set', { findings });
    return;
  }
  const finalRepair = reviewsExhausted(e);
  const mine = findings.filter((f) => f.owner !== "tester");
  const theirs = findings.filter((f) => f.owner === "tester");
  const head = finalRepair
    ? `Final repair round ${c.round} (review requested changes). There is no further review, so fix every finding below completely`
    : `Repair round ${c.round} (review requested changes). Fix every finding below completely`;
  const reopened = findings.filter((f) => f.origin === "unfixed").map((f) => f.id);
  const reopenedMine = mine.filter((f) => f.origin === "unfixed").map((f) => f.id);
  const reopenedText = reopenedMine.length
    ? [`Still open after an earlier repair reported them fixed: ${reopenedMine.join(", ")}. The Fix condition is unchanged; the Planner's repair design (contract amendment) says how the rule is enforced. Fix the rule at that enforcement point for every input, not the cited example.`]
    : [];
  const text = [
    `${head}: meet its Fix condition and the contract obligations it names, fix the root cause and the same defect anywhere else in the phase diff, and check that the fix works with the evidence the declared gates produce. Report \`resolutions\` for: ${mine.map((f) => f.id).join(", ")}.`,
    ...reopenedText,
    "When the contract does not define how a finding must be repaired (you would have to invent a design decision), report it as needs_design instead of guessing.",
    ...(theirs.length ? [`The Tester fixes these test-owned findings after you; do not change tests for them: ${theirs.map((f) => `${f.id} (${f.summary})`).join("; ")}`] : []),
  ].join("\n");
  if (mine.length) c.deltas.implementer = { kind: "repair", text, findings: mine, paths };
  else delete c.deltas.implementer;
  c.work = null;
  const reasons = new Set(mine.map((f) => designReason(c, f)).filter((x): x is DesignState["reason"] => !!x));
  if (mine.length) startDesign(e, mine.map((f) => f.id), reasons.has("plan_cause") ? "plan_cause" : reasons.has("unfixed") ? "unfixed" : reasons.has("related") ? "related" : "repair_plan");
  c.deltas.tester = {
    kind: "repair",
    text: [
      `Round ${c.round}: review findings. Fix the findings owned by the Tester (you own the test code). For every other finding, try to falsify the repair: derive the rule from its Fix line and the contract obligations it names, and test that rule, not the Implementer's claim. Test the cited example, at least one input class that neither the Reviewer nor the Implementer named (another entry point, configuration, boundary, trust case or dependency path), and the enforcement point itself (that no second path bypasses it). Tests must fail without the fix and run in the declared gates.`,
      reopened.length ? `${reopened.join(", ")} came back after an earlier repair and verification: check them hardest.` : "",
      `Prove every Check line with a new testcase of its own; a testcase that already passed when the Reviewer found the defect does not count. Return \`verifications\` for every finding id below (status verified with the testcase names and, per check, \`checks\` [{"n", "tests"}], and the variants you tried; failed when it is not fixed, and list it in failures).`,
    ].filter(Boolean).join(" "),
    findings,
    paths,
  };
  if (finalRepair) delete c.deltas.reviewer;
  else
    c.deltas.reviewer = {
      kind: "rereview",
      text: 'Your previous review requested the changes below. Follow the re-review rules: give "prior" fixed or unfixed for each one against its unchanged Fix condition, check the repair diff for regressions, and report what the earlier review missed. A new way to break the same rule is a new finding with "related".',
      findings,
      paths,
    };
  transition(e, mine.length ? "repairing" : "testing");
}

function finalReviewQuestion(e: Engine): Action {
  const c = cur(e);
  const qid = `final_review-${c.phase}-${c.review_changes ?? 0}`;
  const serious = c.review_findings.filter((f) => f.severity === "high" || f.severity === "critical").length;
  const origins = (["unfixed", "regression", "missed"] as const).map((o) => [o, c.review_findings.filter((f) => f.origin === o).length] as const).filter(([, n]) => n > 0);
  const originText = origins.length ? ` (${origins.map(([o, n]) => `${n} ${o}`).join(", ")})` : "";
  const lineages = [...new Set(c.review_findings.map((f) => lineageOf(c, f.id)))].map((l) => {
    const entries = lineageEntries(c, l);
    return { l, reports: entries.reduce((s, x) => s + x.reports, 0), designs: entries.reduce((s, x) => s + x.designs, 0) };
  });
  const repeated = lineages.filter((x) => x.reports > 1).map((x) => `${x.l} reported ${x.reports}x, ${x.designs} repair design(s)`);
  return ask(
    e,
    "final_review",
    qid,
    `The final review (${c.review_changes ?? 0} of ${reviewCap(e)}) of ${c.phase} still requests changes: ${c.review_findings.length} finding(s)${originText}, ${serious} high or critical (see .looprch/phases/${c.phase}/review.md).${repeated.length ? ` Repeated: ${repeated.join("; ")}.` : ""} Normally the first review finds everything, so this needs your decision. How should Looprch continue?`,
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
  c.last_test_keys = [];
  c.evidence_rounds = 0;
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
      block(e, (err as LrError).code === "spec_changed" ? "spec_changed" : "config_invalid", errorMessage(err), (err as LrError).hint ?? "");
    }
    return true;
  };
  if (r.expansion_requests?.length && r.decision !== "needs_expansion" && (run.role === "tester" || run.role === "reviewer")) {
    try {
      executeExpansions(e, run.role, r.expansion_requests);
    } catch {
      // recorded best-effort only; the verdict stands
    }
  }
  switch (run.task) {
    case "planning":
    case "synthesis":
    case "revise": {
      if (expansion("planner")) return null;
      const path = writeArtifact(e, "plan.md", artifact);
      if (r.contract) {
        const prev = loadContract(e.root, c.phase);
        saveContract(e.root, c.phase, newContract(c.phase, r.contract, (prev?.revision ?? 0) + 1));
        ev(e, { type: "contract.accepted", role: "planner", run_id: run.run_id, data: { task: run.task, obligations: r.contract.obligations.length, deferrals: r.contract.deferrals.length, dispositions: r.debate_dispositions?.length ?? 0 } });
      }
      transition(e, run.task === "planning" ? "debating" : "plan_approval");
      return path;
    }
    case "debate": {
      if (expansion("plan_debater")) return null;
      const path = writeArtifact(e, "debate.md", artifact || "No findings.");
      c.debate_findings = r.decision === "findings" ? (r.findings ?? []).map((f) => f.id) : [];
      transition(e, r.decision === "findings" ? "synthesizing" : "plan_approval");
      return path;
    }
    case "design_review": {
      const path = writeArtifact(e, `design-debate-${c.addenda.length}.md`, artifact || "No findings.");
      const d = c.design;
      if (!d) return path;
      if (r.decision === "findings") {
        d.step = "revise";
        c.deltas.planner = {
          kind: "context_answer",
          text: `The Plan Debater challenged your repair design (read it in your inputs). Revise the design: answer each challenge, and return the complete "repair_packages" again (every finding of the design in a package) and, for ${(d.amend ?? []).join(", ") || "no finding"}, the complete contract_amendment (each repair obligation lists the finding ids it answers in "resolves"). Do not write code.`,
          findings: (r.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, summary: f.summary })),
          paths: [path],
        };
      } else finishDesign(e);
      return path;
    }
    case "context_answer": {
      const n = c.addenda.length + 1;
      const path = writeArtifact(e, `plan-addendum-${n}.md`, artifact);
      c.addenda.push(path);
      if (r.contract_amendment) {
        const base = loadContract(e.root, c.phase) ?? newContract(c.phase, { obligations: [], deferrals: [] }, 0);
        const next = amend(base, r.contract_amendment);
        saveContract(e.root, c.phase, next);
        const kept = new Set(contractIds(next));
        c.retired_obligations = [...new Set([...(c.retired_obligations ?? []), ...(r.contract_amendment.retire ?? [])])].filter((id) => !kept.has(id));
        if (c.work?.kind === "implementation" && !c.design && r.contract_amendment.work_packages?.length) {
          const work = c.work;
          const upd = new Map(r.contract_amendment.work_packages.map((w) => [w.id, w]));
          const pending = [...work.items.filter((w) => !work.done.includes(w.id)).map((w) => upd.get(w.id) ?? w), ...r.contract_amendment.work_packages.filter((w) => !work.items.some((x) => x.id === w.id))];
          work.items = [...work.items.filter((w) => work.done.includes(w.id)), ...(orderWork(pending) ?? pending)];
        }
        ev(e, { type: "contract.amended", role: "planner", run_id: run.run_id, data: { revision: next.revision, obligations: (r.contract_amendment.obligations ?? []).map((o) => o.id), deferrals: (r.contract_amendment.deferrals ?? []).map((x) => x.id), retired: r.contract_amendment.retire ?? [], design: c.design?.findings ?? null } });
      }
      const prior = c.deltas.implementer;
      const design = c.design;
      if (design) c.pending_repair_packages = r.repair_packages ?? null;
      const answered = design
        ? `The Planner wrote a repair design (${path.split("/").pop()}) for: ${design.findings.join(", ")}${r.contract_amendment ? ", and amended contract.json" : ""}. Its repair packages run one at a time; the package for this run is below. The design and any amended obligations are binding: implement them exactly as defined; do not patch around them.`
        : `The Planner answered your context request (${c.context_request?.question ?? ""}). Continue.`;
      const rest = prior?.text?.startsWith("The Planner wrote a repair design") ? prior.text.split("\n\n").slice(1).join("\n\n") : prior?.text;
      c.deltas.implementer = { ...prior, kind: "context_answer", text: rest ? `${answered}\n\n${rest}` : answered, paths: [...(prior?.paths ?? []), path] };
      if (design) {
        if (design.step === "design" && design.debate) {
          design.step = "debate";
          c.deltas.plan_debater = {
            kind: "design_review",
            text: `Challenge the Planner's repair design (${path.split("/").pop()}) and its contract amendment once, for: ${design.findings.join(", ")}. For each: is the rule decidable and complete at its single enforcement point (no list of known bad cases), testable, feasible in this phase (or deferred with a fail-closed interim), and consistent with the contract and the packet? Could a cheaper model execute each repair package literally, or would it still have to invent a decision (name the step)?`,
            findings: design.findings.map((id) => c.review_findings.find((f) => f.id === id)).filter((f): f is Finding => !!f),
            paths: [path],
          };
        } else finishDesign(e);
      } else c.context_request = null;
      return path;
    }
    case "implementation":
    case "repair": {
      if (r.decision === "needs_context") {
        c.context_request = { question: r.context_request!.question, reason: r.context_request!.reason, documents: r.context_request!.documents ?? [], phases: r.context_request!.phases ?? [] };
        c.deltas.planner = { kind: "context_answer", text: `Implementer question: ${c.context_request.question}\nReason: ${c.context_request.reason}` };
        if (priorDelta) c.deltas.implementer = priorDelta;
        return null;
      }
      recordImplementer(e, run);
      if (run.task === "repair") c.repair_reports = [...(c.repair_reports ?? []), rel(e, join(projectPaths(e.root).run(run.run_id), "final.md"))];
      if (r.resolutions?.length) {
        const open = new Set(c.acknowledged_open ?? []);
        for (const x of r.resolutions) {
          if (x.status === "fixed") open.delete(x.id);
          else open.add(x.id);
        }
        c.acknowledged_open = [...open];
      }
      if (run.task === "repair" && c.repair_source === "review") {
        const done = new Set(c.designed_this_round ?? []);
        const scope = new Set(currentWorkItem(c)?.findings ?? (priorDelta?.findings ?? []).map((f) => f.id));
        const mine = (r.resolutions ?? []).filter((x) => scope.has(x.id));
        const ask = mine.filter((x) => x.status === "needs_design" && !done.has(x.id)).map((x) => x.id);
        if (ask.length) {
          const pending = mine.filter((x) => x.status === "not_fixed" && !done.has(x.id)).map((x) => x.id);
          startDesign(e, [...ask, ...pending], "needs_design");
          if (priorDelta) c.deltas.implementer = priorDelta;
          return null;
        }
      }
      const label = run.task === "implementation" ? "implementation" : `repair ${c.round}`;
      const item = currentWorkItem(c);
      if (item) {
        c.work!.done.push(item.id);
        ev(e, { type: "work.done", role: "implementer", run_id: run.run_id, data: { kind: c.work!.kind, id: item.id, done: c.work!.done.length, total: c.work!.items.length } });
        if (currentWorkItem(c)) {
          e.st.pending_checkpoint = { label: `${label} ${item.id}` };
          if (c.work!.base) c.deltas.implementer = c.work!.base;
          return null;
        }
        c.work = null;
      }
      e.st.pending_checkpoint = { label: item ? `${label} ${item.id}` : label };
      transition(e, "testing");
      return null;
    }
    case "testing": {
      const path = writeArtifact(e, "test-report.md", artifact);
      c.tester_verdict = r.decision === "pass" ? "pass" : "fail";
      c.tester_failures = (r.failures ?? []).map((f) => ({ id: f.id, summary: f.summary, gate_id: f.gate_id, files: f.files }));
      const verifs: Verification[] = (r.verifications ?? []).map((v) => ({ id: v.id, status: v.status, tests: v.tests, variants: v.variants, ...(v.checks?.length ? { checks: v.checks } : {}), ...(v.note ? { note: v.note } : {}) }));
      for (const v of verifs)
        if (v.status === "failed" && !c.tester_failures.some((f) => f.id === v.id)) c.tester_failures.push({ id: v.id, summary: `verification failed${v.note ? `: ${v.note}` : ""}` });
      const merged = new Map((c.tester_verifications ?? []).map((v) => [v.id, v]));
      for (const v of verifs) merged.set(v.id, v);
      c.tester_verifications = [...merged.values()];
      for (const m of r.manual_gate_reports ?? []) c.manual_reports[m.gate_id] = m.path;
      transition(e, "gating");
      return path;
    }
    case "review": {
      const path = writeArtifact(e, "review.md", artifact);
      for (const m of r.manual_gate_reports ?? []) c.manual_reports[m.gate_id] = m.path;
      const findings: Finding[] = (r.findings ?? []).map((f) => ({
        id: f.id,
        severity: f.severity,
        summary: f.summary,
        files: f.files,
        ...(f.fix ? { fix: f.fix } : {}),
        ...(f.cause === "test" ? { owner: "tester" as const } : f.owner ? { owner: f.owner } : {}),
        ...(f.origin ? { origin: f.origin } : {}),
        ...(f.cause ? { cause: f.cause } : {}),
        ...(f.obligations?.length ? { obligations: f.obligations } : {}),
        ...(f.related ? { related: f.related } : {}),
        ...(f.checks?.length ? { checks: f.checks } : {}),
      }));
      updateLedger(e, findings, r.prior ?? []);
      const merged = new Map((c.contract_review ?? []).map((x) => [x.id, x.status]));
      const stillOpen = new Set(findings.flatMap((f) => f.obligations ?? []));
      const fixed = new Set((r.prior ?? []).filter((p) => p.status === "fixed").map((p) => p.id));
      for (const f of c.review_findings) if (fixed.has(f.id)) for (const o of f.obligations ?? []) if (!stillOpen.has(o) && merged.get(o) === "not_met") merged.set(o, "met");
      for (const o of stillOpen) if (merged.has(o)) merged.set(o, "not_met");
      for (const x of r.contract_review ?? []) merged.set(x.id, x.status);
      c.contract_review = [...merged].map(([id, status]) => ({ id, status }));
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
        c.acknowledged_open = [];
        c.reviewed_tree = c.snapshots.gates;
        c.reviewed_cases = c.passing_cases ?? { available: false, cases: [] };
        if (reviewsExhausted(e)) c.final_review_pending = true;
        else repairOrBlock(e, "review", findings, [path], findingSummary(findings));
      }
      return path;
    }
    case "handover":
      return acceptHandover(e, run, r, artifact);
    case "adhoc_review":
    case "worker":
      return null;
    default: {
      const never: never = run.task;
      throw new LrError("internal", `unhandled task ${String(never)}`);
    }
  }
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

function findingLines(findings: Finding[]): string[] {
  return findings.map((f) => `- ${f.id}${f.severity ? ` [${f.severity}]` : ""}: ${f.summary}${f.files?.length ? ` (${f.files.join(", ")})` : ""}`);
}

function contractSection(contract: Contract | null, review: { id: string; status: string }[]): string {
  if (!contract) return "- (this phase has no contract.json)";
  const status = new Map(review.map((x) => [x.id, x.status]));
  const lines = [`Contract revision ${contract.revision}: ${contract.obligations.length} obligation(s), ${contract.deferrals.length} deferral(s). Status from the latest review that reported it.`, ""];
  for (const o of contract.obligations) lines.push(`- ${o.id} [${status.get(o.id) ?? "not reviewed"}] (${o.requirements.join(", ") || "no requirement id"}): ${o.statement}`);
  lines.push("", "### Deferrals to later phases", "");
  if (!contract.deferrals.length) lines.push("- none");
  for (const d of contract.deferrals) lines.push(`- ${d.id} -> ${d.to_phase} [${status.get(d.id) ?? "not reviewed"}] (${d.requirements.join(", ")}): ${d.what}. Until then: ${d.interim}`);
  return lines.join("\n");
}

function notesSection(findings: Finding[]): string {
  if (!findings.length) return "";
  return ["", "## Open review notes (approved, not repaired)", "", "The approving review listed these findings without requesting changes:", "", ...findingLines(findings), ""].join("\n");
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function acceptHandover(e: Engine, run: RunRecord, r: RoleResult, artifact: string): string | null {
  const c = cur(e);
  const snap = snapshotTree(e.root);
  if (snap !== c.snapshots.gates) {
    ev(e, { type: "warning", data: { message: "The handover run changed files; gates and review must run again" } });
    c.snapshots.review = null;
    transition(e, "gating");
    return null;
  }
  const actual = diffNameStatus(e.root, c.phase_base!, snap);
  const claimedRenames = (r.renamed ?? []).map((x) => `${x.from}->${x.to}`);
  const actualRenames = actual.renamed.map((x) => `${x.from}->${x.to}`);
  const mismatches: string[] = [];
  if (!sameSet(r.modified_files ?? [], actual.modified)) mismatches.push(`modified: claimed [${(r.modified_files ?? []).join(", ")}], actual [${actual.modified.join(", ")}]`);
  if (!sameSet(r.new_files ?? [], actual.added)) mismatches.push(`new: claimed [${(r.new_files ?? []).join(", ")}], actual [${actual.added.join(", ")}]`);
  if (!sameSet(r.deleted_files ?? [], actual.deleted)) mismatches.push(`deleted: claimed [${(r.deleted_files ?? []).join(", ")}], actual [${actual.deleted.join(", ")}]`);
  if (!sameSet(claimedRenames, actualRenames)) mismatches.push(`renamed: claimed [${claimedRenames.join(", ")}], actual [${actualRenames.join(", ")}]`);
  if (mismatches.length) {
    if (c.reask_count < 1) {
      c.reask_count++;
      c.deltas.implementer = { kind: "reask", text: `Your handover file lists do not match git (diff since ${c.phase_base}). Fix the lists; do not change files.\n${mismatches.map((m) => `- ${m}`).join("\n")}` };
      ev(e, { type: "run.reask", role: "implementer", run_id: run.run_id, data: { mismatches } });
      return null;
    }
    block(e, "handover_mismatch", `The handover file lists still do not match git: ${mismatches.join("; ")}`, "Correct the handover yourself or run looprch resume to ask again", { mismatches });
    return null;
  }
  c.reask_count = 0;
  const p = e.st.phases[c.phase]!;
  const gates = loadGates(e.root, c.phase);
  const tpl = readFileSync(join(packageRoot(), "assets", "templates", "handover.md"), "utf8");
  const extra = tpl
    .replace("{{contributors}}", p.implementers.map((i) => `- ${i.agent} / ${i.model}: runs ${i.runs.join(", ")}`).join("\n") || "- (none recorded)")
    .replace("{{gate_runs}}", Object.values(gates.latest).map((id) => {
      const g = gates.runs.find((x) => x.gate_run_id === id)!;
      return `- ${g.gate_id}: ${g.gate_run_id}, ${g.ok ? "passed" : "failed"}, tests ${g.evidence.tests}, evidence sha256 ${g.evidence.sha256 ?? "-"}, tree ${g.snapshot_tree}`;
    }).join("\n"))
    .replace("{{unreviewed}}", `${c.snapshots.review ? "" : unreviewedSection(e, c.review_findings)}${notesSection(c.review_notes ?? [])}`)
    .replace("{{contract}}", contractSection(loadContract(e.root, c.phase), c.contract_review ?? []));
  const path = writeArtifact(e, "handover.md", `${artifact.trim()}\n${extra}`);
  c.snapshots.handover = snap;
  ev(e, { type: "handover.accepted", run_id: run.run_id, data: { files: actual } });
  c.close_step = "ticks";
  transition(e, "closing");
  return path;
}

// ---------------------------------------------------------------------------------------------
// gates, checkpoints, closing, finish

export function applyGates(e: Engine, outcome: GatesOutcome): void {
  const c = cur(e);
  for (const r of outcome.runs) ev(e, { type: "gate.result", data: { gate_id: r.gate_id, gate_run_id: r.gate_run_id, ok: r.ok, reason: r.reason, tests: r.evidence.tests } });
  ev(e, { type: "gates.run", data: { all_passed: outcome.all_passed, snapshot: outcome.snapshot_tree } });
  const acknowledged = new Set(c.acknowledged_open ?? []);
  const carried = outcome.all_passed && c.tester_verdict === "fail" && c.tester_failures.length > 0 && (c.review_changes ?? 0) > 0 && c.tester_failures.every((f) => acknowledged.has(f.id));
  if (carried)
    ev(e, { type: "warning", data: { message: `The Tester's failures are findings the Implementer reported not_fixed (${c.tester_failures.map((f) => f.id).join(", ")}); they go to the review instead of another test repair` } });
  if (outcome.all_passed && (c.tester_verdict === "pass" || carried)) {
    const index = testcaseIndex(e.root, outcome.runs);
    const retired = new Set(c.retired_obligations ?? []);
    const current = (c.tester_verifications ?? []).filter((v) => !retired.has(v.id));
    const open = new Set((c.review_changes ?? 0) > 0 ? c.review_findings.map((f) => f.id) : []);
    const changed = new Set(c.reviewed_tree ? changedBetween(e.root, c.reviewed_tree, outcome.snapshot_tree) : []);
    const stale = [...unprovenChecks(c, current, open), ...(open.size && c.reviewed_cases ? staleClaims(current, open, c.reviewed_cases, changed, e.root) : [])];
    const unbacked = [...unbackedTests(current, index, e.root), ...stale];
    ev(e, { type: "evidence.checked", data: { binding: index.available ? "testcases" : "files", cases: index.cases.length, verifications: (c.tester_verifications ?? []).length, unbacked: unbacked.length - stale.length, stale: stale.length } });
    if (unbacked.length) {
      const byId = new Map<string, string[]>();
      for (const u of unbacked) byId.set(u.id, [...(byId.get(u.id) ?? []), `${u.test} (${u.reason})`]);
      const findings: Finding[] = [...byId].map(([id, why]) => {
        const rf = open.has(id) ? c.review_findings.find((f) => f.id === id) : undefined;
        return { id, gate_id: EVIDENCE_GATE, summary: `claimed tests not backed by the gate evidence: ${why.join("; ")}`, ...(rf?.severity ? { severity: rf.severity } : {}), ...(rf?.fix ? { fix: rf.fix } : {}), ...(rf?.checks?.length ? { checks: rf.checks } : {}) };
      });
      ev(e, { type: "evidence.unbacked", role: "tester", data: { verifications: [...byId.keys()], tests: unbacked.map((u) => u.test).slice(0, 50) } });
      repairOrBlock(e, "test", findings, [], `unbacked verifications ${[...byId.keys()].join(", ")}`, true);
      return;
    }
    c.passing_cases = { available: index.available, cases: index.cases.filter((x) => x.status === "passed").map((x) => ({ name: x.name, classname: x.classname, file: x.file })) };
    c.snapshots.gates = outcome.snapshot_tree;
    afterGatesPassed(e);
    return;
  }
  const findings: Finding[] = outcome.runs.filter((r) => !r.ok).map((r) => ({ id: r.gate_run_id, gate_id: r.gate_id, summary: `${r.reason ?? "failed"}${r.stdout_tail ? `\n${r.stdout_tail.split("\n").slice(-8).join("\n")}` : ""}` }));
  findings.push(...c.tester_failures);
  const paths = outcome.runs.filter((r) => !r.ok).flatMap((r) => [r.stdout_path, r.stderr_path]);
  repairOrBlock(e, "test", findings, paths, findings.map((f) => f.gate_id ?? f.id).join(", ") || "tester verdict fail");
}

/** Acceptance checks of open review findings that a `verified` verification names no testcase for. */
function unprovenChecks(c: NonNullable<State["current"]>, verifs: Verification[], open: Set<string>): { id: string; test: string; reason: string }[] {
  const out: { id: string; test: string; reason: string }[] = [];
  for (const v of verifs) {
    if (v.status !== "verified" || !open.has(v.id)) continue;
    const checks = c.review_findings.find((f) => f.id === v.id)?.checks ?? [];
    const proven = new Set((v.checks ?? []).filter((x) => x.tests.length).map((x) => x.n));
    checks.forEach((text, i) => {
      if (!proven.has(i + 1)) out.push({ id: v.id, test: `check ${i + 1}`, reason: `check ${i + 1} ("${text.slice(0, 120)}") names no testcase in "checks"` });
    });
  }
  return out;
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

export function resume(e: Engine, note: string | null): string[] {
  const st = e.st;
  const cleared: string[] = [];
  if (st.flags.blocked) {
    const code = st.flags.blocked.code;
    if (code === "spec_changed") {
      const v = verifyPackage(e.root);
      if (!v.ok) throw new LrError("spec_changed", "The package still does not verify", "Reseal an authorized amendment with SEV3, then run looprch init discover --accept-fingerprint");
    }
    if (code === "repair_limit" && st.current) {
      st.current.extra_rounds++;
      const c = st.current;
      const open = c.deltas.implementer?.findings ?? [];
      if (c.stage === "repairing" && c.repair_source === "test" && !c.design && !c.work && open.length) startDesign(e, open.map((f) => f.id), "test_repeat", open);
    }
    if (code === "expansion_limit" && st.current) st.current.expansion_round = Math.max(0, st.current.expansion_round - 1);
    if (code === "result_invalid" && st.current) st.current.reask_count = 0;
    if ((code === "run_failed" || code === "cli_missing") && st.current) for (const k of Object.keys(st.current.attempts)) st.current.attempts[k] = 0;
    st.flags.blocked = null;
    cleared.push("blocked");
  }
  if (st.flags.paused) {
    if (st.flags.paused.reason.startsWith("protocol_changed")) markPhaseStart(st);
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
    implementing: "Implementer implements the plan",
    testing: "Tester writes tests",
    gating: "run gates after the tester report",
    reviewing: "Reviewer reviews code and evidence",
    repairing: "Implementer repairs findings",
    handover: "Implementer writes the handover",
    closing: "tick todo.md, commit, merge and tag",
  };
  return map[c.stage];
}