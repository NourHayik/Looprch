import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../helpers/tmp.js";
import { drive, readJson, runDirect, setupProject, type Project } from "../helpers/lead.js";

const next = (p: Project, extra: string[] = [], host = "cursor") => runCli(["next", "--host", host, "--json", ...extra], { cwd: p.root, env: p.env }).json;
const cli = (p: Project, args: string[], input?: string) => runCli([...args, "--json"], { cwd: p.root, env: p.env, input }).json;
const state = (p: Project) => readJson(join(p.root, ".looprch/state.json"));
const patchState = (p: Project, fn: (s: any) => void) => {
  const s = state(p);
  fn(s);
  writeFileSync(join(p.root, ".looprch/state.json"), JSON.stringify(s, null, 2));
};

/** Drive until the given predicate matches an action (that action is NOT executed). */
function until(p: Project, pred: (a: any) => boolean, scope: "phase" | "auto" | "finish" = "phase", answers?: Record<string, string>) {
  return drive({ root: p.root, env: p.env, scope, answers, onAction: (a) => (pred(a) ? "stop" : undefined), stopOn: ["paused", "blocked", "stop_before_closure", "project_done", "phase_closed"] }).last;
}

describe("lifecycle transition rows", () => {
  test("T-N1: finish scope before the closure phase is a non-durable phases_remaining block; host not enabled", () => {
    const p = setupProject();
    const a = next(p, ["--scope", "finish"]);
    assert.equal(a.action, "blocked");
    assert.equal(a.code, "phases_remaining");
    assert.equal(a.durable, false);
    assert.equal(state(p).flags.blocked, null);
    const h = next(p, [], "grok");
    assert.equal(h.code, "host_not_enabled");
    p.s.cleanup();
  });

  test("T-preflight: unacknowledged gates ask; stop on baseline blocks dirty_tree; resume after commit continues", () => {
    const p = setupProject();
    const cfgPath = join(p.root, ".looprch/config.json");
    const cfg = readJson(cfgPath);
    cfg.spec.gates_ack = null;
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const a = next(p);
    assert.equal(a.action, "ask_user");
    assert.equal(a.kind, "ack_gates");
    cli(p, ["answer", a.question_id, "acknowledge"]);
    const b = next(p);
    assert.equal(b.kind, "commit_baseline");
    cli(p, ["answer", b.question_id, "stop"]);
    const c = next(p);
    assert.equal(c.action, "blocked");
    assert.equal(c.code, "dirty_tree");
    assert.equal(next(p).code, "dirty_tree", "blocked is durable");
    p.s.cleanup();
  });

  test("T-preflight: a project that was never discovered is not_initialized", () => {
    const p = setupProject();
    patchState(p, (s) => (s.spec.package_fingerprint = null));
    const a = next(p);
    assert.equal(a.code, "not_initialized");
    p.s.cleanup();
  });

  test("T-G4/G5: a pending question is asked again; an unrecorded Direct run is re-issued with attempt+1", () => {
    const p = setupProject();
    const q1 = next(p);
    assert.equal(q1.kind, "commit_baseline");
    assert.equal(next(p).question_id, q1.question_id);
    cli(p, ["answer", q1.question_id, "commit_baseline"]);
    const r1 = next(p);
    assert.equal(r1.action, "run_role");
    assert.equal(r1.mode, "direct");
    const r2 = next(p);
    assert.equal(r2.run_id, r1.run_id);
    assert.equal(r2.attempt, r1.attempt + 1);
    p.s.cleanup();
  });

  test("T-G6: pause takes effect at the next boundary; resume continues", () => {
    const p = setupProject();
    const a = until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    cli(p, ["pause"]);
    const still = next(p);
    assert.equal(still.run_id, a.run_id, "an issued run is still handed out before pausing");
    cli(p, ["dispatch", a.run_id]);
    assert.equal(next(p).action, "paused");
    cli(p, ["resume"]);
    assert.notEqual(next(p).action, "paused");
    p.s.cleanup();
  });

  test("T-G2: a protocol change mid-phase pauses until resumed", () => {
    const p = setupProject();
    until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    patchState(p, (s) => (s.protocol = 0));
    const a = next(p);
    assert.equal(a.action, "paused");
    assert.match(a.reason, /protocol_changed/);
    cli(p, ["resume"]);
    assert.equal(state(p).protocol, 3);
    assert.notEqual(next(p).action, "paused");
    p.s.cleanup();
  });

  test("T-planning: needs_expansion builds an exact-source expansion packet and resumes the Planner", () => {
    const p = setupProject({ roles: { ...defaultRolesDelegatePlanner() } });
    p.setScenario([
      { role: "planner", phase: "P-001", task: "planning", nth: 1, decision: "needs_expansion", final: 'Need more.\n\n```looprch-result\n{"role":"planner","decision":"needs_expansion","expansion_requests":[{"kind":"document","id":"R-OPERATIONS","question":"What does closure need?","reason":"compatibility"}]}\n```' },
    ]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    assert.equal(a.role, "plan_debater");
    assert.ok(existsSync(join(p.root, ".looprch/packets/P-001/planner-exp-1.md")));
    const calls = readFileSync(p.scenario.replace("scenario.json", "fake-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.role === "planner");
    assert.equal(calls.length, 2);
    assert.ok(calls[1].session, "second planner call resumes the session");
    const brief = readFileSync(join(p.root, ".looprch/runs/P-001-planner-2/brief.md"), "utf8");
    assert.match(brief, /planner-exp-1\.md/);
    p.s.cleanup();
  });

  test("T-planning: expansion limit blocks", () => {
    const p = setupProject({ roles: defaultRolesDelegatePlanner(), config: { "limits.expansion_rounds": "0" } });
    p.setScenario([{ role: "planner", decision: "needs_expansion", final: '```looprch-result\n{"role":"planner","decision":"needs_expansion","expansion_requests":[{"kind":"document","id":"F-NOTES","question":"q","reason":"r"}]}\n```' }]);
    const last = until(p, () => false);
    assert.equal(last.code, "expansion_limit");
    p.s.cleanup();
  });

  test("T-plan_approval: approvals.plan always asks; revise sends the Planner back with the user's text", () => {
    const p = setupProject({ config: { "approvals.plan": "always" } });
    const q = until(p, (x) => x.action === "ask_user" && x.kind === "approve_plan");
    assert.equal(q.kind, "approve_plan");
    cli(p, ["answer", q.question_id, "revise", "--text", "Add input validation notes"]);
    const r = next(p);
    assert.equal(r.role, "planner");
    assert.equal(r.task, "revise");
    assert.match(readFileSync(join(p.root, r.brief), "utf8"), /Add input validation notes/);
    runDirect(r, { root: p.root, env: p.env });
    const q2 = next(p);
    assert.equal(q2.kind, "approve_plan");
    assert.notEqual(q2.question_id, q.question_id);
    p.s.cleanup();
  });

  test("T-implementing: needs_context goes to the Planner, then back to the same Implementer session", () => {
    const p = setupProject();
    p.setScenario([{ role: "implementer", phase: "P-001", task: "implementation", nth: 1, decision: "needs_context" }]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "tester");
    assert.equal(a.role, "tester");
    assert.ok(existsSync(join(p.root, ".looprch/phases/P-001/plan-addendum-1.md")));
    const calls = readFileSync(p.scenario.replace("scenario.json", "fake-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const impl = calls.filter((c) => c.role === "implementer");
    assert.equal(impl.length, 2);
    assert.equal(impl[1].session, JSON.parse(readFileSync(join(p.root, ".looprch/runs/P-001-implementer-1/relay/result.json"), "utf8")).sessionId);
    p.s.cleanup();
  });

  test("T-closing: approvals.merge always + hold pauses; resume asks again; merge closes", () => {
    const p = setupProject({ config: { "approvals.merge": "always" } });
    const q = until(p, (x) => x.action === "ask_user" && x.kind === "approve_merge");
    cli(p, ["answer", q.question_id, "hold"]);
    assert.equal(next(p).action, "paused");
    cli(p, ["resume"]);
    const q2 = next(p);
    assert.equal(q2.kind, "approve_merge");
    cli(p, ["answer", q2.question_id, "merge"]);
    assert.equal(next(p).action, "phase_closed");
    p.s.cleanup();
  });

  test("T-context: a packet above the budget asks when a larger fallback exists", () => {
    const p = setupProject({ config: { "context_kb.opencode": "1", "context_kb.codex": "4000" } });
    const q = until(p, (x) => x.action === "ask_user" && x.kind === "context_over_budget");
    assert.equal(q.kind, "context_over_budget");
    cli(p, ["answer", q.question_id, q.options[1].id]);
    const r = next(p);
    assert.equal(r.role, "implementer");
    assert.equal(r.agent, "codex");
    assert.equal(r.mode_reason, "user_choice");
    p.s.cleanup();
  });

  test("T-result: a missing result block is re-asked once in the same session, then accepted", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", phase: "P-001", nth: 1, omit_block: true }]);
    const a = until(p, (x) => x.action === "checkpoint");
    assert.equal(a.label, "plan approved");
    const ev = readFileSync(join(p.root, ".looprch/events.jsonl"), "utf8");
    assert.match(ev, /"run\.reask"/);
    const runs = readdirSync(join(p.root, ".looprch/runs")).filter((r) => r.includes("plan_debater"));
    assert.equal(runs.length, 2);
    assert.match(readFileSync(join(p.root, ".looprch/runs/P-001-plan_debater-2/brief.md"), "utf8"), /was rejected/);
    p.s.cleanup();
  });

  test("T-result: two invalid blocks block result_invalid", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", omit_block: true }]);
    const last = until(p, () => false);
    assert.equal(last.code, "result_invalid");
    p.s.cleanup();
  });
});

function defaultRolesDelegatePlanner() {
  return {
    planner: { mode: "delegate" as const, agent: "codex", model: "codex-plan" },
    plan_debater: { mode: "delegate" as const, agent: "kimi", model: "kimi-k" },
    implementer: { mode: "delegate" as const, agent: "opencode", model: "oc/impl" },
    tester: { mode: "delegate" as const, agent: "codex", model: "codex-test" },
    reviewer: { mode: "direct" as const, agent: "cursor", model: "cursor-review" },
  };
}
