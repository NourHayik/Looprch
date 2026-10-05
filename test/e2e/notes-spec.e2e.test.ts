import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, git, runCli } from "../helpers/tmp.js";
import { quotaJson } from "../helpers/fakes.js";
import { drive, readJson, setupProject, type Project } from "../helpers/lead.js";

const cli = (p: Project, args: string[]) => runCli([...args, "--json"], { cwd: p.root, env: p.env }).json;
const next = (p: Project, host = "cursor", scope = "phase") => cli(p, ["next", "--host", host, "--scope", scope]);
const calls = (p: Project) => readFileSync(p.scenario.replace("scenario.json", "fake-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const events = (p: Project) => readFileSync(join(p.root, ".looprch/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const state = (p: Project) => readJson(join(p.root, ".looprch/state.json"));
const stopAt = (pred: (a: any) => boolean) => (a: any) => (pred(a) ? ("stop" as const) : undefined);

/** Tree of a commit without .looprch/ and phases/todo.md (what Looprch's snapshots hash). */
function treeWithoutLooprch(p: Project, rev: string): string {
  const idx = join(mkdtempSync(join(tmpdir(), "lr-idx-")), "index");
  const env = { GIT_INDEX_FILE: idx };
  git(p.root, ["read-tree", rev], env);
  git(p.root, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ".looprch", "phases/todo.md"], env);
  return git(p.root, ["write-tree"], env);
}

describe("e2e: SEV3 notes-spec with fake relays", { concurrency: 3 }, () => {
  test("E-1 happy path: auto stops before closure, finish completes the project", () => {
    const p = setupProject();
    const auto = drive({ root: p.root, env: p.env, scope: "auto" });
    assert.equal(auto.last.action, "stop_before_closure");
    assert.equal(auto.last.closure_phase, "P-003");
    const fin = drive({ root: p.root, env: p.env, scope: "finish" });
    assert.equal(fin.last.action, "project_done", JSON.stringify(fin.actions.slice(-2)));
    const todo = readFileSync(join(p.root, "phases/todo.md"), "utf8");
    assert.doesNotMatch(todo, /- \[ \]/, "every box ticked");
    for (const id of ["P-001", "P-002", "P-003"]) {
      const tag = `looprch/${id}`;
      assert.notEqual(git(p.root, ["tag", "-l", tag]), "");
      assert.equal(git(p.root, ["log", "-1", "--format=%P", tag]).split(" ").length, 2, `${tag} is a no-ff merge`);
      const handover = readFileSync(join(p.root, `.looprch/phases/${id}/handover.md`), "utf8");
      assert.match(handover, /## Phase Summary/);
      assert.match(handover, /Contributing implementers/);
      const gates = readJson(join(p.root, `.looprch/phases/${id}/gates.json`));
      const last = gates.runs.find((r: any) => r.gate_run_id === Object.values(gates.latest)[0]);
      assert.equal(last.ok, true);
      assert.equal(last.snapshot_tree, treeWithoutLooprch(p, tag), `${id} gates ran on the closed tree`);
    }
    assert.ok(existsSync(join(p.root, ".looprch/FINAL_REPORT.md")));
    assert.match(readFileSync(join(p.root, ".looprch/FINAL_REPORT.md"), "utf8"), /application_verified \(toolkit field\): false/);
    assert.equal(git(p.root, ["status", "--porcelain"]), "");
    assert.equal(git(p.root, ["log", "-1", "--format=%s"]), "looprch: project complete");
    assert.equal(next(p, "cursor", "auto").action, "project_done");
    p.s.cleanup();
  });

  test("E-2 test repair: a failing gate goes back to the same Implementer session", () => {
    const p = setupProject();
    drive({ root: p.root, env: p.env, scope: "phase" });
    p.setScenario([{ role: "implementer", phase: "P-002", task: "implementation", nth: 1, variant: "buggy" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const impl = calls(p).filter((c) => c.role === "implementer" && c.phase === "P-002");
    assert.deepEqual(impl.map((c) => c.task), ["implementation", "repair", "handover"]);
    assert.ok(impl[1].args.includes("--session"));
    assert.equal(impl[1].session, readJson(join(p.root, ".looprch/runs/P-002-implementer-1/relay/result.json")).sessionId);
    const gates = readJson(join(p.root, ".looprch/phases/P-002/gates.json"));
    assert.equal(gates.runs[0].ok, false);
    assert.equal(gates.runs.at(-1).ok, true);
    assert.equal(state(p).phases["P-002"].rounds_used, 1);
    assert.match(git(p.root, ["log", "--format=%s", "looprch/P-002"]), /looprch\(P-002\): repair 1/);
    p.s.cleanup();
  });

  test("E-3 review repair: changes requested, repaired, re-tested, approved", () => {
    const p = setupProject();
    p.setScenario([{ role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const seq = r.actions.filter((a) => a.action === "run_role").map((a) => `${a.role}:${a.task}`);
    const i = seq.indexOf("reviewer:review");
    assert.deepEqual(seq.slice(i, i + 4), ["reviewer:review", "implementer:repair", "tester:testing", "reviewer:review"]);
    assert.ok(existsSync(join(p.root, ".looprch/phases/P-001/review.r0.md")));
    p.s.cleanup();
  });

  test("E-4 repair cap: blocked at the limit; resume --note grants one round with the note in the brief", () => {
    const p = setupProject({ config: { "limits.repair_rounds": "1" } });
    p.setScenario([
      { role: "implementer", phase: "P-001", task: "implementation", variant: "none" },
      { role: "implementer", phase: "P-001", task: "repair", nth: 1, variant: "none" },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "blocked");
    assert.equal(r.last.code, "repair_limit");
    cli(p, ["resume", "--note", "Implement validate_id exactly as the contract says"]);
    const r2 = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r2.last.action, "phase_closed");
    const repairs = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith("P-001-implementer-")).sort();
    const lastRepair = repairs.map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8")).find((b) => b.includes("User note:"));
    assert.ok(lastRepair, "the note reached a repair brief");
    p.s.cleanup();
  });

  test("E-4b review cap: three change requests, a final repair, then handover without a fourth review", () => {
    const p = setupProject();
    p.setScenario([{ role: "reviewer", phase: "P-001", decision: "changes_requested" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed", JSON.stringify(r.last));
    const seq = r.actions.filter((a) => a.action === "run_role").map((a) => `${a.role}:${a.task}`);
    assert.equal(seq.filter((x) => x === "reviewer:review").length, 3);
    const lastReview = seq.lastIndexOf("reviewer:review");
    assert.deepEqual(seq.slice(lastReview, lastReview + 4), ["reviewer:review", "implementer:repair", "tester:testing", "implementer:handover"]);
    const briefs = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith("P-001-reviewer-")).sort().map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8"));
    assert.match(briefs[0]!, /Review round 1 of 3/);
    assert.match(briefs[1]!, /re-review/);
    assert.match(briefs[2]!, /This is the final review/);
    const finalRepair = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith("P-001-implementer-")).map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8")).find((b) => b.includes("Final repair round"));
    assert.ok(finalRepair, "the last repair is told there is no further review");
    assert.ok(events(p).some((e) => e.type === "review.skipped"));
    assert.match(readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8"), /## Open review findings \(final repair, not re-reviewed\)[\s\S]*R-1 \[high\]/);
    p.s.cleanup();
  });

  test("E-4c repair limit after a review: resume continues with the repair, not another review", () => {
    const p = setupProject({ config: { "limits.repair_rounds": "1" } });
    p.setScenario([{ role: "reviewer", phase: "P-001", decision: "changes_requested" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.code, "repair_limit");
    assert.equal(state(p).current.stage, "repairing");
    cli(p, ["resume", "--note", "Fix R-1"]);
    const a = next(p);
    assert.equal(`${a.role}:${a.task}`, "implementer:repair");
    p.s.cleanup();
  });

  test("E-5 detached run survives a killed Lead and a killed dispatcher", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", sleep_ms: 4000 }]);
    const a = drive({ root: p.root, env: p.env, onAction: stopAt((x) => x.action === "run_role" && x.role === "plan_debater") }).last;
    const child = spawn(process.execPath, [CLI, "dispatch", a.run_id, "--json"], { cwd: p.root, env: { ...process.env, ...p.env }, stdio: "ignore" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    child.kill("SIGKILL");
    const w = next(p);
    assert.equal(w.action, "await_run");
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.equal(readJson(join(p.root, `.looprch/runs/${a.run_id}/run.json`)).status, "completed");
    p.s.cleanup();
  });

  test("E-6 interrupted relay: retried with the same session", () => {
    const p = setupProject();
    p.setScenario([{ role: "implementer", phase: "P-001", task: "handover", nth: 1, kill_self: true }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.ok(events(p).some((e) => e.type === "run.interrupted"));
    const ho = calls(p).filter((c) => c.role === "implementer" && c.task === "handover");
    assert.equal(ho.length, 2);
    assert.ok(ho[1].session);
    assert.equal(ho[1].session, ho[0].session);
    p.s.cleanup();
  });

  test("E-7 spec change after P-001 blocks; closed evidence is untouched", () => {
    const p = setupProject();
    drive({ root: p.root, env: p.env, scope: "phase" });
    const handover = readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8");
    appendFileSync(join(p.root, "phases/en/P-002.md"), "\nUnsealed edit.\n");
    git(p.root, ["commit", "-qam", "user edits the spec"]);
    const a = next(p);
    assert.equal(a.action, "blocked");
    assert.equal(a.code, "spec_changed");
    assert.equal(readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8"), handover);
    assert.equal(state(p).phases["P-001"].status, "closed");
    p.s.cleanup();
  });

  test("E-8 quota wait: exhausted with a reset in seconds waits, then runs on the same agent", () => {
    const p = setupProject();
    p.quota(quotaJson([{ id: "opencode", remaining: 0, resets_at: new Date(Date.now() + 4000).toISOString() }]));
    const r = drive({
      root: p.root,
      env: p.env,
      onAction: (a) => {
        if (a.action === "wait") p.quota(quotaJson([{ id: "opencode", remaining: 80, resets_at: null }]));
        return a.action === "run_role" && a.role === "implementer" ? "stop" : undefined;
      },
    });
    assert.ok(r.actions.some((a) => a.action === "wait"));
    assert.equal(r.last.agent, "opencode");
    p.s.cleanup();
  });

  test("E-9 quota fallback mid-phase: checkpoint before the switch, both implementers traced", () => {
    const p = setupProject();
    p.setScenario([{ role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" }]);
    const r = drive({
      root: p.root,
      env: p.env,
      scope: "phase",
      onAction: (a) => {
        if (a.action === "run_role" && a.role === "reviewer") p.quota(quotaJson([{ id: "opencode", remaining: 0, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() }]));
      },
    });
    assert.equal(r.last.action, "phase_closed");
    assert.match(git(p.root, ["log", "--format=%s", "looprch/P-001"]), /agent switch \(implementer opencode -> codex\)/);
    const handover = readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8");
    assert.match(handover, /opencode \/ oc\/impl/);
    assert.match(handover, /codex \/ codex-impl/);
    const hist = state(p).assignments_history.filter((h: any) => h.role === "implementer");
    assert.ok(hist.some((h: any) => h.reason === "quota_fallback"));
    const repairBrief = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith("P-001-implementer-")).map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8")).find((b) => b.includes("take over"));
    assert.ok(repairBrief && /diff\.patch/.test(repairBrief), "the new agent gets the diff and earlier final messages");
    p.s.cleanup();
  });

  test("E-10 rate-limit text falls back", () => {
    const p = setupProject();
    p.setScenario([{ agent: "opencode", role: "implementer", status: "failed", stderr: "You have reached your usage limit" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.deepEqual([...new Set(calls(p).filter((c) => c.role === "implementer").map((c) => c.agent))], ["opencode", "codex"]);
    p.s.cleanup();
  });

  test("E-11 a read-only debater that touches a file blocks", () => {
    const p = setupProject();
    p.setScenario([{ role: "plan_debater", touch: "x.txt" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.code, "readonly_violation");
    assert.match(r.last.reason, /x\.txt/);
    p.s.cleanup();
  });

  test("E-12 a missing result block is re-asked in the same session", () => {
    const p = setupProject();
    p.setScenario([{ role: "tester", phase: "P-001", nth: 1, omit_block: true }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const t = calls(p).filter((c) => c.role === "tester");
    assert.equal(t.length, 2);
    assert.equal(t[1].session, t[0].session === null ? t[1].session : readJson(join(p.root, ".looprch/runs/P-001-tester-1/relay/result.json")).threadId);
    p.s.cleanup();
  });

  test("E-13 a handover that omits a new file is re-asked and corrected", () => {
    const p = setupProject();
    p.setScenario([{ role: "implementer", phase: "P-001", task: "handover", nth: 1, omit_new_file: true }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(readFileSync(join(p.root, ".looprch/runs/P-001-implementer-3/brief.md"), "utf8"), /do not match git/);
    p.s.cleanup();
  });

  test("E-14 D-05: with the Lead in codex, the Direct cursor Planner runs through cursor-delegate", () => {
    const p = setupProject();
    const r = drive({ root: p.root, env: p.env, host: "codex", onAction: stopAt((a) => a.action === "run_role" && a.role === "plan_debater") });
    const planner = r.actions.find((a) => a.action === "run_role" && a.role === "planner");
    assert.equal(planner.mode, "delegate");
    assert.equal(planner.mode_reason, "d05_auto_delegate");
    assert.ok(calls(p).some((c) => c.agent === "cursor" && c.role === "planner"));
    assert.ok(events(p).some((e) => e.type === "mode.auto_delegate"));
    p.s.cleanup();
  });

  test("E-15 a user commit on main during a phase makes the merge conflict; the phase branch survives", () => {
    const p = setupProject();
    drive({ root: p.root, env: p.env, scope: "phase" });
    const r = drive({
      root: p.root,
      env: p.env,
      scope: "phase",
      onAction: (a) => {
        if (a.action === "run_role" && a.role === "reviewer") {
          git(p.root, ["stash", "-q"]);
          git(p.root, ["switch", "-q", "main"]);
          writeFileSync(join(p.root, "noteapp.py"), "# user rewrite\n");
          git(p.root, ["commit", "-qam", "user edit on main"]);
          git(p.root, ["switch", "-q", "looprch/P-002"]);
          git(p.root, ["stash", "pop", "-q"]);
        }
      },
    });
    assert.equal(r.last.action, "blocked");
    assert.equal(r.last.code, "merge_conflict");
    assert.equal(git(p.root, ["rev-parse", "--abbrev-ref", "HEAD"]), "looprch/P-002");
    assert.equal(git(p.root, ["status", "--porcelain", "--", "noteapp.py"]), "");
    p.s.cleanup();
  });

  test("E-16 HEAD mismatch blocks; pause during a run waits for it, then pauses; resume continues", () => {
    const p = setupProject();
    drive({ root: p.root, env: p.env, onAction: stopAt((a) => a.action === "run_role" && a.role === "plan_debater") });
    git(p.root, ["switch", "-q", "main"]);
    const b = next(p);
    assert.equal(b.code, "head_mismatch");
    git(p.root, ["switch", "-q", "looprch/P-001"]);
    cli(p, ["resume"]);
    p.setScenario([{ role: "plan_debater", sleep_ms: 2500 }]);
    const a = next(p);
    assert.equal(a.role, "plan_debater");
    assert.equal(cli(p, ["dispatch", a.run_id, "--max-wait", "1s"]).status, "running");
    cli(p, ["pause"]);
    assert.equal(next(p).action, "await_run");
    cli(p, ["dispatch", "--wait", a.run_id]);
    assert.equal(next(p).action, "paused");
    cli(p, ["resume"]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    p.s.cleanup();
  });
});
