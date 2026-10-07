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
    const run = (id: string) => readJson(join(p.root, `.looprch/runs/${id}/run.json`));
    const brief = (id: string) => readFileSync(join(p.root, `.looprch/runs/${id}/brief.md`), "utf8");
    assert.equal(run("P-001-reviewer-1").timeout, "60m");
    assert.equal(run("P-001-reviewer-2").timeout, "90m", "the second review round gets more time");
    assert.match(brief("P-001-reviewer-1"), /Time budget: up to 60m/);
    const reReview = brief("P-001-reviewer-2");
    assert.match(reReview, /Repair since your last review: `git diff --stat [0-9a-f]{40} [0-9a-f]{40}`/);
    assert.match(reReview, /P-001-implementer-2\/final\.md` — Implementer repair report/);
    assert.match(brief("P-001-implementer-2"), /Report `resolutions` for: R-1\./);
    assert.match(brief("P-001-implementer-2"), /Fix: Scripted fix condition/);
    const tester = brief("P-001-tester-2");
    assert.match(tester, /try to falsify the repair: derive the rule from its Fix line/);
    assert.match(tester, /Return `verifications` for every finding id below/);
    assert.match(tester, /P-001-implementer-2\/final\.md/);
    assert.match(reReview, /Give `prior` \(fixed or unfixed\) for every finding in the Delta/);
    const repair = events(p).find((e) => e.type === "result.accepted" && e.data.task === "repair");
    assert.deepEqual(repair.data.resolutions, [{ id: "R-1", status: "fixed", files: 1 }]);
    assert.equal(state(p).phases["P-001"].status, "closed");
    assert.ok(r.progress.some((l) => /review round 2 of 3 · time budget 90m/.test(l)));
    p.s.cleanup();
  });

  test("E-3b a test-owned review finding goes to the Tester; the Implementer is skipped", () => {
    const p = setupProject();
    p.setScenario([{ role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested", findings: [{ id: "R-7", severity: "medium", summary: "Concurrency test missing", files: ["test_noteapp.py"], fix: "two-connection test", owner: "tester" }] }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const seq = r.actions.filter((a) => a.action === "run_role").map((a) => `${a.role}:${a.task}`);
    const i = seq.indexOf("reviewer:review");
    assert.deepEqual(seq.slice(i, i + 3), ["reviewer:review", "tester:testing", "reviewer:review"]);
    assert.match(readFileSync(join(p.root, ".looprch/runs/P-001-tester-2/brief.md"), "utf8"), /R-7 \[medium, owner tester, cause test\]: Concurrency test missing/);
    p.s.cleanup();
  });

  test("E-3c a repair without resolutions for every assigned finding is re-asked", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "implementer", phase: "P-001", task: "repair", nth: 1, omit_resolutions: true },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const reask = events(p).find((e) => e.type === "result.rejected" && e.role === "implementer");
    assert.match(reask.data.errors.join(";"), /resolutions must list every finding assigned to you.*missing: R-1/);
    assert.equal(calls(p).filter((c) => c.role === "implementer" && c.task === "repair").length, 2);
    p.s.cleanup();
  });

  test("E-3e a finding that comes back unfixed gets a Planner repair design and is flagged to the Implementer and the Tester", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "reviewer", phase: "P-001", nth: 2, decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "Scripted finding", files: ["noteapp.py"], fix: "Reject every variant", owner: "implementer", origin: "unfixed" }] },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const briefs = (role: string) => readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith(`P-001-${role}-`)).sort().map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8"));
    const repairs = briefs("implementer").filter((b) => /task=repair/.test(b));
    assert.equal(repairs.length, 2);
    assert.doesNotMatch(repairs[0]!, /Still open after an earlier repair/);
    assert.match(repairs[1]!, /Still open after an earlier repair reported them fixed: R-1\. The Fix condition is unchanged/);
    assert.match(repairs[1]!, /The Planner wrote a repair design \(plan-addendum-1\.md\) and amended contract\.json for: R-1/);
    assert.match(repairs[1]!, /plan-addendum-1\.md/);
    assert.match(repairs[1]!, /Report `resolutions` for: R-1\./);
    const seq = r.actions.filter((a) => a.action === "run_role").map((a) => `${a.role}:${a.task}`);
    const second = seq.indexOf("reviewer:review", seq.indexOf("reviewer:review") + 1);
    assert.deepEqual(seq.slice(second, second + 4), ["reviewer:review", "planner:context_answer", "plan_debater:design_review", "implementer:repair"], "a high finding's repair design is challenged once");
    const design = briefs("planner").find((b) => /task=context_answer/.test(b))!;
    assert.match(design, /Repair design for R-1: an earlier repair reported them fixed/);
    assert.match(design, /- R-1 \[high, owner implementer, cause implementation, unfixed\]/);
    assert.match(design, /"contract_amendment"/);
    const contract = readJson(join(p.root, ".looprch/phases/P-001/contract.json"));
    assert.equal(contract.revision, 2);
    assert.deepEqual(contract.obligations.find((o: any) => o.id.startsWith("O-D")).resolves, ["R-1"]);
    assert.ok(existsSync(join(p.root, ".looprch/phases/P-001/contract.r0.json")));
    assert.ok(briefs("tester").some((b) => /R-1 came back after an earlier repair and verification: check them hardest/.test(b)));
    assert.match(briefs("reviewer").at(-1)!, /plan-addendum-1\.md` — Planner addendum/);
    assert.ok(events(p).some((e) => e.type === "design.escalated" && e.data.reason === "unfixed" && e.data.debate === true));
    assert.ok(r.progress.some((l) => /\[REPAIR DESIGN\]/.test(l)));
    assert.ok(r.progress.some((l) => /\[DESIGN DEBATE COMPLETE\] Result: the repair design holds\./.test(l)));
    p.s.cleanup();
  });

  test("E-3d the final review blocks only on high/critical; approval notes reach the handover", () => {
    const p = setupProject({ config: { "limits.review_rounds": "1" } });
    const medium = { id: "R-1", severity: "medium", summary: "Edge case", files: ["noteapp.py"] };
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested", findings: [medium] },
      { role: "reviewer", phase: "P-001", nth: 2, decision: "approve", findings: [{ ...medium, id: "R-9", summary: "Edge case left as a note" }] },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const rejected = events(p).find((e) => e.type === "result.rejected" && e.role === "reviewer");
    assert.match(rejected.data.errors.join(";"), /final review: changes_requested needs a high or critical finding/);
    assert.match(readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8"), /## Open review notes \(approved, not repaired\)[\s\S]*R-9 \[medium\]: Edge case left as a note/);
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

  test("E-4b review cap: the final review still requests changes, the user hands over without a fourth review", () => {
    const p = setupProject();
    p.setScenario([{ role: "reviewer", phase: "P-001", decision: "changes_requested" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase", answers: { final_review: "repair_and_handover" } });
    assert.equal(r.last.action, "phase_closed", JSON.stringify(r.last));
    const asked = r.actions.filter((a) => a.action === "ask_user" && a.kind === "final_review");
    assert.equal(asked.length, 1, "the user decides after the final review");
    assert.deepEqual(asked[0].options.map((o: any) => o.id), ["repair_and_review", "repair_and_handover", "pause"]);
    const seq = r.actions.filter((a) => a.action === "run_role").map((a) => `${a.role}:${a.task}`);
    assert.equal(seq.filter((x) => x === "reviewer:review").length, 3);
    assert.deepEqual(
      ["P-001-reviewer-1", "P-001-reviewer-2", "P-001-reviewer-3"].map((id) => readJson(join(p.root, `.looprch/runs/${id}/run.json`)).timeout),
      ["60m", "90m", "2h"],
    );
    const lastReview = seq.lastIndexOf("reviewer:review");
    assert.deepEqual(seq.slice(lastReview, lastReview + 6), ["reviewer:review", "planner:context_answer", "plan_debater:design_review", "implementer:repair", "tester:testing", "implementer:handover"], "an unfixed high finding gets a redesign the Debater challenges before the final repair");
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

  test("E-4c review repairs do not use the test repair limit; at that limit resume continues with the repair", () => {
    const p = setupProject({ config: { "limits.repair_rounds": "1" } });
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "tester", phase: "P-001", nth: 2, decision: "fail" },
      { role: "tester", phase: "P-001", nth: 3, decision: "fail" },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.code, "repair_limit");
    const st = state(p).current;
    assert.equal(st.stage, "repairing");
    assert.equal(st.review_changes, 1);
    assert.equal(st.test_repairs, 2);
    assert.equal(st.round, 3, "one review repair and two test repairs");
    cli(p, ["resume", "--note", "Fix T-1"]);
    const a = next(p);
    assert.equal(`${a.role}:${a.task}`, "implementer:repair");
    p.s.cleanup();
  });

  test("E-4d after the final review the user can allow one more review", () => {
    const p = setupProject({ config: { "limits.review_rounds": "2" } });
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "reviewer", phase: "P-001", nth: 2, decision: "changes_requested" },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase", answers: { final_review: "repair_and_review" } });
    assert.equal(r.last.action, "phase_closed");
    const reviews = r.actions.filter((a) => a.action === "run_role" && a.role === "reviewer");
    assert.equal(reviews.length, 3);
    const third = readFileSync(join(p.root, `.looprch/${reviews[2].brief.replace(/^\.looprch\//, "")}`), "utf8");
    assert.match(third, /Review round 3 of 3\./);
    assert.match(third, /This is the final review/);
    assert.ok(!events(p).some((e) => e.type === "review.skipped"));
    assert.doesNotMatch(readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8"), /Open review findings/);
    p.s.cleanup();
  });

  test("E-4e pausing at the final review decision asks again after resume", () => {
    const p = setupProject({ config: { "limits.review_rounds": "1" } });
    p.setScenario([{ role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase", answers: { final_review: "pause" } });
    assert.equal(r.last.action, "paused");
    cli(p, ["resume"]);
    const a = next(p);
    assert.equal(a.action, "ask_user");
    assert.equal(a.kind, "final_review");
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

const roleSeq = (r: { actions: any[] }) => r.actions.filter((a) => a.action === "run_role").map((a) => `${a.role}:${a.task}`);
const rejected = (p: Project, role: string) => events(p).filter((e) => e.type === "result.rejected" && e.role === role).map((e) => e.data.errors.join(";"));
const after = (seq: string[], item: string, nth = 1) => {
  let i = -1;
  for (let k = 0; k < nth; k++) i = seq.indexOf(item, i + 1);
  return seq.slice(i);
};

describe("e2e: the phase contract and convergence (0.5.0)", { concurrency: 3 }, () => {
  test("C-1 a contract that leaves a mapped requirement uncovered is re-asked; the accepted contract is saved", () => {
    const p = setupProject();
    p.setScenario([{ role: "planner", phase: "P-001", task: "planning", nth: 1, drop_requirement: "R-ID" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "planner")[0]!, /every mapped requirement of P-001 needs an obligation or a deferral; uncovered: R-ID/);
    const contract = readJson(join(p.root, ".looprch/phases/P-001/contract.json"));
    assert.deepEqual(contract.obligations[0].requirements, ["G-001", "R-ID"]);
    assert.ok(r.progress.some((l) => /^\[CONTRACT\] P-001 contract: 1 obligation, 0 deferrals/.test(l)));
    for (const role of ["plan-debater", "implementer", "tester", "reviewer"]) {
      const b = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith(`P-001-${role.replace("-", "_")}-`)).map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8"));
      assert.ok(b.some((x) => /contract\.json` — /.test(x)), `${role} gets the contract`);
    }
    const handover = readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8");
    assert.match(handover, /## Phase contract \(recorded by Looprch\)[\s\S]*- O-1 \[met\]/);
    p.s.cleanup();
  });

  test("C-2 a contract that never covers the phase blocks result_invalid after one re-ask", () => {
    const p = setupProject();
    p.setScenario([{ role: "planner", phase: "P-001", task: "planning", drop_requirement: "G-001" }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.code, "result_invalid");
    assert.match(r.last.reason, /uncovered: G-001/);
    p.s.cleanup();
  });

  test("C-3 synthesis must disposition every debate finding", () => {
    const p = setupProject();
    p.setScenario([
      { role: "plan_debater", phase: "P-001", decision: "findings", findings: [{ id: "D-1", severity: "high", summary: "No trust source" }, { id: "D-2", severity: "low", summary: "Naming" }] },
      { role: "planner", phase: "P-001", task: "synthesis", nth: 1, omit_dispositions: true },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "planner")[0]!, /debate_dispositions must list every Plan Debate finding.*missing: D-1, D-2/);
    const accepted = events(p).find((e) => e.type === "contract.accepted" && e.data.task === "synthesis");
    assert.equal(accepted.data.dispositions, 2);
    p.s.cleanup();
  });

  test("C-4 a Plan defect found by the Reviewer goes to a Planner contract amendment before the Implementer", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested", findings: [{ id: "R-1", severity: "medium", summary: "No trust source defined for ids", files: ["noteapp.py"], fix: "Fail closed until a source exists", owner: "implementer", cause: "plan" }] },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.deepEqual(after(roleSeq(r), "reviewer:review").slice(0, 5), ["reviewer:review", "planner:context_answer", "implementer:repair", "tester:testing", "reviewer:review"], "medium finding: no design debate");
    const ev = events(p).find((e) => e.type === "design.escalated");
    assert.equal(ev.data.reason, "plan_cause");
    assert.equal(ev.data.debate, false);
    assert.ok(events(p).some((e) => e.type === "contract.amended"));
    p.s.cleanup();
  });

  test("C-5 a violated obligation goes straight to the Implementer and is marked not_met", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested", findings: [{ id: "R-1", severity: "high", summary: "validate_id accepts empty ids", files: ["noteapp.py"], fix: "Reject empty ids", owner: "implementer", obligations: ["O-1"] }] },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.deepEqual(after(roleSeq(r), "reviewer:review").slice(0, 2), ["reviewer:review", "implementer:repair"]);
    assert.ok(!events(p).some((e) => e.type === "design.escalated"));
    const review = events(p).find((e) => e.type === "result.accepted" && e.data.task === "review");
    assert.deepEqual(review.data.contract_unmet, ["O-1"]);
    const repair = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith("P-001-implementer-")).map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8")).find((b) => /task=repair/.test(b))!;
    assert.match(repair, /  Contract: O-1/);
    p.s.cleanup();
  });

  test("C-6 a reviewer that leaves an obligation unreviewed or a not_met without a finding is re-asked", () => {
    const p = setupProject();
    p.setScenario([{ role: "reviewer", phase: "P-001", nth: 1, contract_review: [{ id: "O-1", status: "not_met" }] }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "reviewer")[0]!, /every not_met obligation needs a finding that lists it in "obligations": O-1/);
    p.s.cleanup();
  });

  test("C-7 false fixed: a fixed resolution whose files did not change is rejected", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "implementer", phase: "P-001", task: "repair", nth: 1, no_change: true, variant: "none" },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "implementer")[0]!, /these resolutions say fixed, but none of their files changed since the review: R-1/);
    p.s.cleanup();
  });

  test("C-8 false Verified: a claimed testcase the gate evidence does not have sends the round back to the Tester alone", () => {
    const p = setupProject();
    p.setScenario([{ role: "tester", phase: "P-001", nth: 1, bad_tests: true }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    const seq = roleSeq(r);
    assert.deepEqual(after(seq, "tester:testing").slice(0, 3), ["tester:testing", "tester:testing", "reviewer:review"], "no Implementer run for an evidence mismatch");
    const unbacked = events(p).find((e) => e.type === "evidence.unbacked");
    assert.deepEqual(unbacked.data.verifications, ["O-1"]);
    assert.ok(r.progress.some((l) => /\[EVIDENCE MISMATCH\]/.test(l)));
    const second = readFileSync(join(p.root, ".looprch/runs/P-001-tester-2/brief.md"), "utf8");
    assert.match(second, /could not back the claims below/);
    assert.match(second, /O-1 \(evidence-binding\): claimed tests not backed by the gate evidence: tests\/test_missing\.py::test_nope/);
    assert.equal(state(p).phases["P-001"].status, "closed");
    p.s.cleanup();
  });

  test("C-9 a tester verification missing for an obligation or a review finding is re-asked", () => {
    const p = setupProject();
    p.setScenario([{ role: "tester", phase: "P-001", nth: 1, verifications: [] }]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "tester")[0]!, /verifications must cover every contract obligation and deferral.*missing: O-1/);
    p.s.cleanup();
  });

  test("C-10 a new way to break an earlier rule (related) gets a repair design; re-reviews must state prior", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested", findings: [{ id: "R-1", severity: "medium", summary: "ids must be validated", files: ["noteapp.py"], fix: "Reject invalid ids", owner: "implementer" }] },
      { role: "reviewer", phase: "P-001", nth: 2, omit_prior: true, decision: "changes_requested", findings: [{ id: "R-2", severity: "medium", summary: "ids with whitespace still pass", files: ["noteapp.py"], fix: "One validated path", owner: "implementer", related: "R-1", origin: "missed" }] },
      { role: "reviewer", phase: "P-001", nth: 3, decision: "changes_requested", findings: [{ id: "R-2", severity: "medium", summary: "ids with whitespace still pass", files: ["noteapp.py"], fix: "One validated path", owner: "implementer", related: "R-1", origin: "missed" }] },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase", answers: { final_review: "repair_and_handover" } });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "reviewer")[0]!, /a re-review lists every earlier finding in "prior".*missing: R-1/);
    const design = events(p).find((e) => e.type === "design.escalated");
    assert.equal(design.data.reason, "related");
    assert.deepEqual(design.data.findings, ["R-2"]);
    p.s.cleanup();
  });

  test("C-11 re-review ids and origins must agree with the earlier findings", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "reviewer", phase: "P-001", nth: 2, decision: "changes_requested", raw_findings: [{ id: "R-1", severity: "high", summary: "different defect", files: ["noteapp.py"], cause: "implementation", origin: "missed", checks: ["c"] }], prior: [{ id: "R-1", status: "fixed" }] },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "reviewer")[0]!, /R-1 is an earlier finding: report it only as origin unfixed/);
    p.s.cleanup();
  });

  test("C-12 needs_design: the Implementer asks for a design, the Planner amends, the same Implementer session continues", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "implementer", phase: "P-001", task: "repair", nth: 1, resolution_status: "needs_design" },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.deepEqual(after(roleSeq(r), "reviewer:review").slice(0, 5), ["reviewer:review", "implementer:repair", "planner:context_answer", "plan_debater:design_review", "implementer:repair"]);
    assert.equal(events(p).find((e) => e.type === "design.escalated").data.reason, "needs_design");
    const repairs = calls(p).filter((c) => c.role === "implementer" && c.task === "repair");
    assert.equal(repairs.length, 2);
    assert.ok(repairs[1].session, "the second repair resumes a session");
    assert.equal(repairs[1].session, readJson(join(p.root, ".looprch/runs/P-001-implementer-2/relay/result.json")).sessionId);
    p.s.cleanup();
  });

  test("C-13 a finding unfixed after a repair design gets a redesign that the Plan Debater challenges", () => {
    const p = setupProject();
    const r1 = { id: "R-1", severity: "medium", summary: "ids must be validated", files: ["noteapp.py"], fix: "Reject invalid ids", owner: "implementer" };
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested", findings: [r1] },
      { role: "reviewer", phase: "P-001", nth: 2, decision: "changes_requested", findings: [{ ...r1, origin: "unfixed", fix: "a moved goalpost" }] },
      { role: "reviewer", phase: "P-001", nth: 3, decision: "changes_requested", findings: [{ ...r1, severity: "high", origin: "unfixed" }] },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase", answers: { final_review: "repair_and_handover" } });
    assert.equal(r.last.action, "phase_closed");
    const designs = events(p).filter((e) => e.type === "design.escalated");
    assert.equal(designs.length, 2);
    assert.equal(designs[0].data.debate, false, "medium, first design");
    assert.equal(designs[1].data.debate, true);
    assert.deepEqual(designs[1].data.redesign, ["R-1"]);
    const final = r.actions.find((a) => a.action === "ask_user" && a.kind === "final_review");
    assert.match(final.question, /Repeated: R-1 reported 3x, 1 repair design\(s\)/);
    const repairBriefs = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith("P-001-implementer-")).sort().map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8")).filter((b) => /task=repair/.test(b));
    assert.ok(repairBriefs.slice(1).every((b) => /Fix: Reject invalid ids/.test(b) && !/moved goalpost/.test(b)), "an unfixed finding keeps its first Fix");
    const planner = readdirSync(join(p.root, ".looprch/runs")).filter((d) => d.startsWith("P-001-planner-")).map((d) => readFileSync(join(p.root, ".looprch/runs", d, "brief.md"), "utf8")).filter((b) => /task=context_answer/.test(b));
    assert.ok(planner.some((b) => /R-1 already had a repair design that did not hold/.test(b)));
    p.s.cleanup();
  });

  test("C-14 deferrals reach the next phase: its contract must cover them; the handover lists them", () => {
    const p = setupProject();
    p.setScenario([
      { role: "planner", phase: "P-001", task: "planning", deferrals: [{ id: "X-1", requirements: ["R-ID"], what: "Id reuse across notes", to_phase: "P-002", interim: "reject reuse" }] },
      { role: "planner", phase: "P-002", task: "planning", nth: 1, contract: { obligations: [{ id: "O-1", requirements: ["G-001", "R-ID", "R-NOTE"], kind: "behavior", statement: "notes", enforcement: "noteapp.py", verify: "tests", gates: ["GATE-P-002-negative"] }], deferrals: [] } },
    ]);
    drive({ root: p.root, env: p.env, scope: "phase" });
    assert.match(readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8"), /### Deferrals to later phases[\s\S]*- X-1 -> P-002 \[met\] \(R-ID\): Id reuse across notes\. Until then: reject reuse/);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.match(rejected(p, "planner")[0]!, /deferrals from earlier phases to P-002 must be covered.*P-001\/X-1/);
    const incoming = readJson(join(p.root, ".looprch/phases/P-002/incoming-deferrals.json"));
    assert.equal(incoming[0].ref, "P-001/X-1");
    assert.deepEqual(readJson(join(p.root, ".looprch/phases/P-002/contract.json")).obligations[0].covers, ["P-001/X-1"]);
    const brief = readFileSync(join(p.root, ".looprch/runs/P-002-planner-1/brief.md"), "utf8");
    assert.match(brief, /incoming-deferrals\.json` — deferrals that closed phases made to P-002/);
    p.s.cleanup();
  });

  test("C-16 false Verified with an old test: a proof that already passed on the reviewed tree goes back to the Tester", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "tester", phase: "P-001", nth: 2, no_test_change: true },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.deepEqual(after(roleSeq(r), "implementer:repair").slice(0, 4), ["implementer:repair", "tester:testing", "tester:testing", "reviewer:review"]);
    const checked = events(p).filter((e) => e.type === "evidence.checked");
    assert.ok(checked.some((e) => e.data.stale === 2), "both checks of the high finding cited only an unchanged test");
    const brief = readFileSync(join(p.root, ".looprch/runs/P-001-tester-3/brief.md"), "utf8");
    assert.match(brief, /R-1 \[high\] \(evidence-binding\): claimed tests not backed by the gate evidence: .*check 1: every cited testcase already passed on the reviewed tree/);
    assert.match(brief, /  Check 2: scripted check: a variant/, "the evidence round keeps the finding's checks");
    const repair = readFileSync(join(p.root, ".looprch/runs/P-001-implementer-2/brief.md"), "utf8");
    assert.match(repair, /  Check 1: scripted check: the cited example\n  Check 2: scripted check: a variant/);
    p.s.cleanup();
  });

  test("C-17 a verified high finding must prove every acceptance check; unproven checks go back to the Tester", () => {
    const p = setupProject();
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "tester", phase: "P-001", nth: 2, omit_checks: true },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    assert.deepEqual(rejected(p, "tester"), [], "missing check proofs are an evidence gap, not an invalid result");
    assert.deepEqual(after(roleSeq(r), "implementer:repair").slice(0, 4), ["implementer:repair", "tester:testing", "tester:testing", "reviewer:review"]);
    const brief = readFileSync(join(p.root, ".looprch/runs/P-001-tester-3/brief.md"), "utf8");
    assert.match(brief, /check 1 \("scripted check: the cited example"\) names no testcase in "checks"/);
    assert.match(brief, /check 2 \("scripted check: a variant"\) names no testcase/);
    p.s.cleanup();
  });

  test("C-18 a finding the Implementer reports not_fixed goes back to the review, not into repeated test repairs", () => {
    const p = setupProject({ config: { "limits.repair_rounds": "1" } });
    p.setScenario([
      { role: "reviewer", phase: "P-001", nth: 1, decision: "changes_requested" },
      { role: "implementer", phase: "P-001", task: "repair", nth: 1, resolution_status: "not_fixed" },
      {
        role: "tester",
        phase: "P-001",
        nth: 2,
        decision: "fail",
        failures: [{ id: "R-1", summary: "R-1 still holds" }],
        verifications: [
          { id: "O-1", status: "verified", tests: ["tests/test_ids.py"], variants: [] },
          { id: "R-1", status: "failed", tests: [], variants: [] },
        ],
      },
    ]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed", JSON.stringify(r.last));
    assert.deepEqual(after(roleSeq(r), "implementer:repair").slice(0, 3), ["implementer:repair", "tester:testing", "reviewer:review"]);
    assert.ok(events(p).some((e) => e.type === "warning" && /reported not_fixed \(R-1\); they go to the review/.test(e.data.message)));
    assert.equal(state(p).phases["P-001"].status, "closed");
    p.s.cleanup();
  });

  test("C-15 a phase started on protocol 1 without a contract pauses, then resumes and closes", () => {
    const p = setupProject();
    drive({ root: p.root, env: p.env, onAction: stopAt((a) => a.action === "run_role" && a.role === "implementer") });
    const s = state(p);
    s.protocol = 1;
    writeFileSync(join(p.root, ".looprch/state.json"), JSON.stringify(s, null, 2));
    for (const f of readdirSync(join(p.root, ".looprch/phases/P-001")).filter((f) => f.startsWith("contract"))) writeFileSync(join(p.root, ".looprch/phases/P-001", f), "null");
    assert.equal(next(p).action, "paused");
    cli(p, ["resume"]);
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed");
    p.s.cleanup();
  });
});
