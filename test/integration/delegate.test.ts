import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../helpers/tmp.js";
import { quotaJson } from "../helpers/fakes.js";
import { drive, readJson, setupProject, type Project } from "../helpers/lead.js";

const next = (p: Project, host = "cursor") => runCli(["next", "--host", host, "--json"], { cwd: p.root, env: p.env }).json;
const cli = (p: Project, args: string[]) => runCli([...args, "--json"], { cwd: p.root, env: p.env }).json;
const calls = (p: Project) => readFileSync(p.scenario.replace("scenario.json", "fake-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const events = (p: Project) => readFileSync(join(p.root, ".looprch/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

function toDebater(p: Project) {
  return drive({ root: p.root, env: p.env, onAction: (a) => (a.action === "run_role" && a.role === "plan_debater" ? "stop" : undefined) }).last;
}

describe("delegate dispatch", () => {
  test("a long run returns running, next says await_run, --wait records it", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", sleep_ms: 2500 }]);
    const a = toDebater(p);
    const d = cli(p, ["dispatch", a.run_id, "--max-wait", "1s"]);
    assert.equal(d.status, "running");
    const w = next(p);
    assert.equal(w.action, "await_run");
    assert.deepEqual(w.command, ["looprch", "dispatch", "--wait", a.run_id]);
    const done = cli(p, ["dispatch", "--wait", a.run_id, "--max-wait", "30s"]);
    assert.equal(done.status, "completed");
    assert.equal(done.recorded, true);
    p.s.cleanup();
  });

  test("the relay wrapper records the result even when nobody waits", async () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", sleep_ms: 2000 }]);
    const a = toDebater(p);
    assert.equal(cli(p, ["dispatch", a.run_id, "--max-wait", "1s"]).status, "running");
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(readJson(join(p.root, `.looprch/runs/${a.run_id}/run.json`)).status, "completed");
    assert.notEqual(next(p).action, "await_run");
    p.s.cleanup();
  });

  test("a relay killed without a result is interrupted and retried", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", nth: 1, kill_self: true }]);
    const a = toDebater(p);
    cli(p, ["dispatch", a.run_id]);
    const r = next(p);
    assert.equal(r.role, "plan_debater");
    assert.notEqual(r.run_id, a.run_id);
    assert.equal(r.attempt, 2);
    assert.ok(events(p).some((e) => e.type === "run.interrupted"));
    p.s.cleanup();
  });

  test("failing twice moves to the next approved fallback", () => {
    const p = setupProject();
    p.setScenario([{ agent: "opencode", role: "implementer", status: "failed", stderr: "boom" }]);
    const last = drive({ root: p.root, env: p.env, onAction: (a) => (a.action === "run_role" && a.role === "tester" ? "stop" : undefined) }).last;
    assert.equal(last.role, "tester");
    const impl = calls(p).filter((c) => c.role === "implementer");
    assert.deepEqual(impl.map((c) => c.agent), ["opencode", "opencode", "codex"]);
    const st = readJson(join(p.root, ".looprch/state.json"));
    assert.equal(st.assignments_history.at(-1).reason, "run_failed_fallback");
    p.s.cleanup();
  });

  test("a non-resumable run gets a fresh session next time", () => {
    const p = setupProject();
    p.setScenario([
      { role: "implementer", phase: "P-001", task: "implementation", no_session: true },
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
    ]);
    drive({ root: p.root, env: p.env, onAction: (a) => (a.action === "run_role" && a.task === "repair" ? "stop" : undefined) });
    const st = readJson(join(p.root, ".looprch/state.json"));
    assert.equal(st.sessions["P-001/implementer/opencode"].resumable, false);
    p.s.cleanup();
  });

  test("a read-only violation reported by the relay blocks", () => {
    const p = setupProject({
      roles: {
        planner: { mode: "direct", agent: "cursor", model: "m" },
        plan_debater: { mode: "delegate", agent: "agy", model: "g" },
        implementer: { mode: "delegate", agent: "opencode", model: "oc/m" },
        tester: { mode: "delegate", agent: "codex", model: "c" },
        reviewer: { mode: "direct", agent: "cursor", model: "r" },
      },
      agents: "cursor,codex,opencode,kimi,agy",
    });
    p.setScenario([{ role: "plan_debater", read_only_violation: true }]);
    const last = drive({ root: p.root, env: p.env }).last;
    assert.equal(last.code, "readonly_violation");
    assert.ok(calls(p).find((c) => c.role === "plan_debater").args.includes("--read-only"));
    p.s.cleanup();
  });

  test("a relay usage error (exit 2, no result) blocks as a Looprch bug", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", usage_error: true }]);
    const last = drive({ root: p.root, env: p.env }).last;
    assert.equal(last.code, "usage_error");
    p.s.cleanup();
  });

  test("D-05: a Direct cursor role runs through cursor-delegate when the Lead is in codex", () => {
    const p = setupProject();
    const a = drive({ root: p.root, env: p.env, host: "codex", onAction: (x) => (x.action === "run_role" ? "stop" : undefined) }).last;
    assert.equal(a.role, "planner");
    assert.equal(a.mode, "delegate");
    assert.equal(a.mode_reason, "d05_auto_delegate");
    assert.match(a.summary, /direct→delegate/);
    assert.equal(a.model, "cursor-plan");
    p.s.cleanup();
  });

  test("quota exhausted with a reset soon waits; a later reset falls back", () => {
    const p = setupProject();
    p.quota(quotaJson([{ id: "opencode", remaining: 0, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() }]));
    const a = drive({ root: p.root, env: p.env, onAction: (x) => (x.action === "run_role" && x.role === "implementer" ? "stop" : undefined) }).last;
    assert.equal(a.agent, "codex");
    assert.equal(a.mode_reason, "quota_fallback");
    p.s.cleanup();

    const q = setupProject();
    q.quota(quotaJson([{ id: "opencode", remaining: 0, resets_at: new Date(Date.now() + 30 * 60_000).toISOString() }]));
    const w = drive({ root: q.root, env: q.env, onAction: (x) => (x.action === "wait" ? "stop" : undefined) }).last;
    assert.equal(w.action, "wait");
    assert.match(w.reason, /resets at/);
    q.s.cleanup();
  });

  test("rate-limit text triggers the fallback", () => {
    const p = setupProject();
    p.setScenario([{ agent: "opencode", role: "implementer", status: "failed", stderr: "Error: 429 Too Many Requests" }]);
    drive({ root: p.root, env: p.env, onAction: (a) => (a.action === "run_role" && a.role === "tester" ? "stop" : undefined) });
    assert.deepEqual(calls(p).filter((c) => c.role === "implementer").map((c) => c.agent), ["opencode", "codex"]);
    assert.ok(events(p).some((e) => e.type === "ratelimit.detected"));
    p.s.cleanup();
  });

  test("worker runs are side runs: advisory output, lifecycle untouched, max_parallel enforced", () => {
    const p = setupProject();
    writeFileSync(join(p.root, "README.md"), "x");
    const w = cli(p, ["worker", "Where is validate_id?", "--host", "cursor"]);
    assert.equal(w.action, "run_role");
    assert.equal(w.role, "worker");
    const d = cli(p, ["dispatch", w.run_id]);
    assert.equal(d.status, "completed");
    assert.match(d.output_path, /_project\/workers\//);
    assert.equal(readJson(join(p.root, ".looprch/state.json")).current, null);
    p.s.cleanup();
  });
});
