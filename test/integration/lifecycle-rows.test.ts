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

  test("T-G2: a phase from protocol 4 pauses; resume restarts it at planning with the old plan files in v07/", () => {
    const p = setupProject();
    until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    const dir = join(p.root, ".looprch/phases/P-001");
    writeFileSync(join(dir, "contract.json"), "{}");
    patchState(p, (s) => {
      s.protocol = 4;
      s.current.design = { findings: ["R-1"] };
    });
    const a = next(p);
    assert.equal(a.action, "paused");
    assert.match(a.reason, /protocol_changed.*restarts at planning/);
    cli(p, ["resume"]);
    const st = state(p);
    assert.equal(st.protocol, 5);
    assert.equal(st.current.stage, "planning");
    assert.equal(st.current.design, undefined);
    assert.ok(st.current.run_seq.plan_debater >= 1, "run ids keep counting");
    assert.ok(existsSync(join(dir, "v07/contract.json")) && existsSync(join(dir, "v07/plan.md")) && !existsSync(join(dir, "plan.md")));
    const r = next(p);
    assert.equal(r.role, "planner");
    assert.equal(r.task, "planning");
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

  test("T-planning: an expansion request for something that is not a SEV3 source is re-asked, not a block (CoreBit2)", () => {
    const p = setupProject({ roles: { ...defaultRolesDelegatePlanner() } });
    p.setScenario([
      { role: "planner", phase: "P-001", task: "planning", nth: 1, decision: "needs_expansion", final: 'Need rules.\n\n```looprch-result\n{"role":"planner","decision":"needs_expansion","expansion_requests":[{"kind":"document","id":".looprch/user-rules.md","question":"Provide the user rules","reason":"the spec requires them"}]}\n```' },
    ]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    assert.equal(a.role, "plan_debater", JSON.stringify(a));
    const rejected = readFileSync(join(p.root, ".looprch/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "result.rejected");
    assert.match(rejected.data.errors.join(";"), /expansion requests must name SEV3 document ids .*not: document \.looprch\/user-rules\.md/);
    const brief = readFileSync(join(p.root, ".looprch/runs/P-001-planner-1/brief.md"), "utf8");
    assert.match(brief, /`\.looprch\/user-rules\.md` — does not exist: this project has no additional user rules/);
    p.s.cleanup();
  });

  test("T-check: looprch check checks the block without a side effect; a report file replaces a long final message", () => {
    const p = setupProject({ roles: { ...defaultRolesDelegatePlanner() } });
    p.setScenario([{ role: "planner", phase: "P-001", task: "planning", nth: 1, report_file: true }]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "planner");
    const bad = runCli(["check", a.run_id, "--stdin", "--json"], { cwd: p.root, env: p.env, input: '```looprch-result\n{"role":"planner","decision":"plan_ready","plan":{"todos":[]}}\n```' });
    assert.equal(bad.code, 1);
    assert.match(bad.json.errors.join(";"), /plan\.todos must list the todos/);
    const good = runCli(["check", a.run_id, "--stdin", "--json"], { cwd: p.root, env: p.env, input: '```looprch-result\n{"role":"planner","decision":"plan_ready","plan":{"todos":[{"id":"T-1","title":"t"}]}}\n```' });
    assert.equal(good.code, 0, "no coverage, heading or lint rules");
    const missing = runCli(["check", a.run_id, "--json"], { cwd: p.root, env: p.env });
    assert.equal(missing.json.error.code, "no_report");
    assert.equal(readJson(join(p.root, `.looprch/runs/${a.run_id}/run.json`)).status, "issued", "check changes nothing");
    const brief = readFileSync(join(p.root, a.brief), "utf8");
    assert.match(brief, new RegExp(`write your complete report, the markdown and the looprch-result block, to \`\\.looprch/runs/${a.run_id}/report\\.md\``));
    assert.match(brief, new RegExp(`looprch check ${a.run_id} --root `));
    cli(p, ["dispatch", a.run_id]);
    const d = until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    assert.equal(d.role, "plan_debater", "the report file was accepted although the final message had no result block");
    const debaterBrief = readFileSync(join(p.root, d.brief), "utf8");
    assert.match(debaterBrief, /--stdin` and fix what it lists/);
    assert.match(debaterBrief, /The Implementer of this phase is opencode\/oc\/impl/);
    const order = ["plan.md` — the plan to challenge", "plan.json` — the plan's todos", "plan-debater.md` — exact-source SEV3 packet"].map((s) => debaterBrief.indexOf(s));
    assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]!)), "the Debater reads the plan before the packet");
    p.s.cleanup();
  });

  test("T-check: the run's end validates the report file that looprch check validated, not the short final message", () => {
    const p = setupProject({ roles: { ...defaultRolesDelegatePlanner() } });
    p.setScenario([
      { role: "planner", phase: "P-001", task: "planning", nth: 1, report_file: true, plan: { todos: [] }, report_final: "block" },
      { role: "planner", phase: "P-001", task: "planning", nth: 2, report_file: true, report_final: 'Done; see report.md.\n\n```looprch-result\n{"role":"planner","decision":"plan_ready"}\n```' },
    ]);
    const a1 = until(p, (x) => x.action === "run_role" && x.role === "planner");
    cli(p, ["dispatch", a1.run_id]);
    const events = () => readFileSync(join(p.root, ".looprch/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const rejected = events().find((x) => x.type === "result.rejected" && x.run_id === a1.run_id);
    assert.match(rejected.data.errors.join(";"), /plan\.todos must list the todos/);
    const a2 = next(p);
    assert.equal(a2.role, "planner");
    assert.notEqual(a2.run_id, a1.run_id);
    assert.match(readFileSync(join(p.root, a2.brief), "utf8"), /to your report file \(named in the self-check below\), and run looprch check until it prints ok/);
    const report1 = readFileSync(join(p.root, `.looprch/runs/${a1.run_id}/report.md`), "utf8");
    const report2 = join(p.root, `.looprch/runs/${a2.run_id}/report.md`);
    writeFileSync(report2, report1);
    const bad = runCli(["check", a2.run_id, "--json"], { cwd: p.root, env: p.env });
    assert.equal(bad.code, 1, "check rejects the report file the run's end rejects");
    assert.match(bad.json.errors.join(";"), /plan\.todos must list the todos/);
    writeFileSync(report2, report1.replace('"todos":[]', '"todos":[{"id":"T-1","title":"Write noteapp.py"}]'));
    const good = runCli(["check", a2.run_id, "--json"], { cwd: p.root, env: p.env });
    assert.equal(good.code, 0, JSON.stringify(good.json));
    cli(p, ["dispatch", a2.run_id]);
    const d = until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    assert.equal(d.role, "plan_debater", "the report file was accepted although the final message's block had no plan");
    const run2 = join(p.root, `.looprch/runs/${a2.run_id}`);
    assert.equal(readFileSync(join(run2, "final.md"), "utf8"), readFileSync(join(run2, "report.md"), "utf8"), "final.md records the report file");
    assert.match(readFileSync(join(p.root, ".looprch/phases/P-001/plan.md"), "utf8"), /## Overview[\s\S]*## Todo list/);
    p.s.cleanup();
  });

  test("T-check: a final message with the plan block but no markdown does not replace the report file", () => {
    const p = setupProject({ roles: { ...defaultRolesDelegatePlanner() } });
    p.setScenario([{ role: "planner", phase: "P-001", task: "planning", nth: 1, report_file: true, report_final: "block" }]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "planner");
    cli(p, ["dispatch", a.run_id]);
    const d = until(p, (x) => x.action === "run_role" && x.role === "plan_debater");
    assert.equal(d.role, "plan_debater");
    assert.equal(readJson(join(p.root, `.looprch/runs/${a.run_id}/run.json`)).status, "completed");
    assert.match(readFileSync(join(p.root, ".looprch/phases/P-001/plan.md"), "utf8"), /## Overview/, "plan.md is the report file's markdown");
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
    const q2 = until(p, (x) => x.action === "ask_user" && x.kind === "approve_plan");
    assert.equal(q2.kind, "approve_plan");
    assert.ok(existsSync(join(p.root, ".looprch/phases/P-001/plan.r0.md")), "the earlier plan is kept");
    assert.notEqual(q2.question_id, q.question_id);
    p.s.cleanup();
  });

  test("T-implementing: a blocking question goes to the Planner alone (no Debater), the answer lands in plan.md, then the same Implementer session continues", () => {
    const p = setupProject();
    p.setScenario([
      { role: "implementer", phase: "P-001", task: "implementation", nth: 1, decision: "needs_context" },
      { role: "planner", phase: "P-001", task: "context_answer", new_todos: [{ id: "T-9", title: "Add the error type" }] },
    ]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "tester");
    assert.equal(a.role, "tester");
    const plan = readFileSync(join(p.root, ".looprch/phases/P-001/plan.md"), "utf8");
    assert.match(plan, /## Addendum 1: answer to the Implementer\n\n\*\*Question:\*\* Which error type\?\n\nUse ValueError/);
    const calls = readFileSync(p.scenario.replace("scenario.json", "fake-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const answer = calls.findIndex((c) => c.role === "planner" && c.task === "context_answer");
    assert.ok(answer > 0);
    assert.ok(!calls.slice(answer).some((c) => c.role === "plan_debater"), "the Plan Debater does not see the answer");
    const impl = calls.filter((c) => c.role === "implementer" && c.task === "implementation");
    assert.equal(impl.length, 2);
    assert.equal(impl[1].session, JSON.parse(readFileSync(join(p.root, ".looprch/runs/P-001-implementer-2/relay/result.json"), "utf8")).sessionId);
    const brief2 = readFileSync(join(p.root, ".looprch/runs/P-001-implementer-2/brief.md"), "utf8");
    assert.match(brief2, /The Planner answered your question in plan\.md \(Addendum 1, at the end\)\. It added T-9/);
    assert.match(brief2, /- T-9: Add the error type/);
    assert.deepEqual(state(p).current.todos_done, ["T-1", "T-9"]);
    assert.equal(readJson(join(p.root, ".looprch/phases/P-001/plan.json")).todos.length, 2);
    p.s.cleanup();
  });

  test("T-sessions: each Planner session is one Implementer run with its own checkpoint", () => {
    const p = setupProject();
    p.setScenario([{ role: "planner", phase: "P-001", task: "planning", two_sessions: true }]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "tester");
    assert.equal(a.role, "tester");
    const brief = (n: number) => readFileSync(join(p.root, `.looprch/runs/P-001-implementer-${n}/brief.md`), "utf8");
    assert.match(brief(1), /Session 1 of 2\. Do these todos in order[^\n]*:\n- T-1: Write noteapp\.py \[1\. App\]/);
    assert.match(brief(2), /Session 2 of 2\. Do these todos in order, the way plan\.md describes each one \(done in earlier sessions: T-1\):\n- T-2: Wire the CLI/);
    const log = runCli(["log", "--type", "checkpoint.committed", "--json"], { cwd: p.root, env: p.env }).json.map((e: any) => e.data.label);
    assert.deepEqual(log.filter((l: string) => l.startsWith("implementation")), ["implementation session 1", "implementation session 2"]);
    p.s.cleanup();
  });

  test("T-sessions: todos a session leaves open get one follow-up session, then the phase moves on", () => {
    const p = setupProject();
    p.setScenario([{ role: "implementer", phase: "P-001", task: "implementation", todos_done: [] }]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "tester");
    assert.equal(a.role, "tester");
    assert.match(readFileSync(join(p.root, ".looprch/runs/P-001-implementer-2/brief.md"), "utf8"), /Session 2 of 2[^\n]*\n- T-1: Write noteapp\.py/);
    assert.equal(readdirSync(join(p.root, ".looprch/runs")).filter((r) => r.startsWith("P-001-implementer-")).length, 2, "only one follow-up");
    assert.deepEqual(state(p).current.followup_sessions, [1]);
    p.s.cleanup();
  });

  test("T-debate: at the limit, upheld medium items are contested and the phase continues; an upheld high item asks the user", () => {
    const p = setupProject();
    p.setScenario([
      { role: "plan_debater", phase: "P-001", task: "debate", decision: "findings", findings: [{ id: "D-1", severity: "medium", summary: "vague error handling" }] },
      { role: "plan_debater", phase: "P-001", task: "rebuttal", verdict: "upheld" },
    ]);
    const a = until(p, (x) => x.action === "run_role" && x.role === "implementer");
    assert.equal(a.role, "implementer");
    const l = readJson(join(p.root, ".looprch/phases/P-001/debate.json"));
    assert.equal(l.rounds, 2, "the default limit is 2 Debater passes");
    assert.deepEqual(l.entries.map((e: any) => [e.id, e.status, e.disposition.decision]), [["D-1", "contested", "accept"]]);
    p.s.cleanup();
    const q = setupProject();
    q.setScenario([
      { role: "plan_debater", phase: "P-001", task: "debate", decision: "findings", findings: [{ id: "D-1", severity: "high", summary: "no trust source" }] },
      { role: "plan_debater", phase: "P-001", task: "rebuttal", verdict: "upheld" },
    ]);
    const ask = until(q, (x) => x.action === "ask_user" && x.kind === "debate_unresolved");
    assert.equal(ask.kind, "debate_unresolved");
    assert.match(ask.question, /D-1 \[high, planner accept, debater upheld\]: no trust source/);
    q.s.cleanup();
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
    assert.match(readFileSync(join(p.root, ".looprch/runs/P-001-plan_debater-2/brief.md"), "utf8"), /could not read your previous result/);
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
