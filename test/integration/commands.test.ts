import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../helpers/tmp.js";
import { drive, setupProject, type Project } from "../helpers/lead.js";

const cli = (p: Project, args: string[]) => runCli([...args, "--json"], { cwd: p.root, env: p.env });

describe("status, log, review, worker", () => {
  test("status and log from the shell", () => {
    const p = setupProject();
    drive({ root: p.root, env: p.env, onAction: (a) => (a.action === "run_role" && a.role === "tester" ? "stop" : undefined) });
    const s = cli(p, ["status"]).json;
    assert.equal(s.current.phase, "P-001");
    assert.equal(s.current.stage, "testing");
    assert.equal(s.active.role, "tester");
    assert.equal(s.active.agent, "codex");
    assert.equal(s.spec.phases_total, 3);
    const human = runCli(["status"], { cwd: p.root, env: p.env }).stdout;
    assert.match(human, /Phase P-001 \(1\/3\) "Identifier foundation"  stage: testing/);
    const log = cli(p, ["log", "--phase", "P-001", "-n", "5"]).json;
    assert.equal(log.length, 5);
    assert.ok(log.every((e: any) => e.phase === "P-001"));
    const typed = cli(p, ["log", "--type", "phase.started"]).json;
    assert.equal(typed.length, 1);
    p.s.cleanup();
  });

  test("review of a closed phase reads the tag diff and never changes status", () => {
    const p = setupProject();
    drive({ root: p.root, env: p.env, scope: "phase" });
    const r = cli(p, ["review", "P-001", "--host", "cursor"]).json;
    assert.equal(r.action, "run_role");
    assert.equal(r.role, "reviewer");
    assert.equal(r.mode, "direct");
    const brief = readFileSync(join(p.root, r.brief), "utf8");
    assert.match(brief, /git diff looprch\/P-001\^1 looprch\/P-001/);
    assert.match(readFileSync(join(p.root, `.looprch/runs/${r.run_id}/diff.patch`), "utf8"), /noteapp\.py/);
    const before = readFileSync(join(p.root, ".looprch/state.json"), "utf8");
    const rec = runCli(["record", r.run_id, "--stdin", "--json"], { cwd: p.root, env: p.env, input: 'Looks good.\n\n```looprch-result\n{"role":"reviewer","decision":"approve","findings":[]}\n```' }).json;
    assert.equal(rec.status, "accepted");
    assert.match(rec.artifact, /\.looprch\/phases\/P-001\/reviews\/adhoc-/);
    const after = JSON.parse(readFileSync(join(p.root, ".looprch/state.json"), "utf8"));
    assert.equal(after.phases["P-001"].status, "closed");
    assert.equal(after.current, JSON.parse(before).current);
    p.s.cleanup();
  });

  test("worker max_parallel 1 refuses a second concurrent run", () => {
    const p = setupProject();
    runCli(["config", "set-role", "worker", "--mode", "delegate", "--agent", "codex", "--model", "w", "--max-parallel", "1"], { cwd: p.root, env: p.env });
    const a = cli(p, ["worker", "first?", "--host", "cursor"]).json;
    assert.equal(a.action, "run_role");
    const b = cli(p, ["worker", "second?", "--host", "cursor"]);
    assert.equal(b.json.error.code, "worker_limit");
    p.s.cleanup();
  });
});
