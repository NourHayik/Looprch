import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../helpers/tmp.js";
import { drive, readJson, setupProject } from "../helpers/lead.js";

describe("lifecycle (integration)", () => {
  test("P-001 closes with Direct and Delegate roles: todo ticked, tag, gates.json, handover", () => {
    const p = setupProject();
    const r = drive({ root: p.root, env: p.env, scope: "phase" });
    assert.equal(r.last.action, "phase_closed", JSON.stringify(r.actions.slice(-3), null, 1));
    assert.equal(r.last.tag, "looprch/P-001");
    const todo = readFileSync(join(p.root, "phases/todo.md"), "utf8");
    assert.match(todo, /^- \[x\] P-001 - Identifier foundation$/m);
    assert.match(todo, /^ {2}- \[x\] P-001:gate:GATE-P-001-negative$/m);
    assert.match(todo, /^- \[ \] P-002/m);
    assert.notEqual(git(p.root, ["tag", "-l", "looprch/P-001"]), "");
    assert.equal(git(p.root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    const gates = readJson(join(p.root, ".looprch/phases/P-001/gates.json"));
    assert.equal(gates.runs.at(-1).ok, true);
    assert.equal(gates.runs.at(-1).evidence.tests, 3);
    const handover = readFileSync(join(p.root, ".looprch/phases/P-001/handover.md"), "utf8");
    assert.match(handover, /Contributing implementers/);
    assert.match(handover, /opencode \/ oc\/impl/);
    assert.ok(existsSync(join(p.root, ".looprch/phases/P-001/plan.md")));
    const kinds = r.actions.map((a) => a.action);
    assert.ok(kinds.includes("checkpoint"));
    assert.ok(kinds.includes("run_gates"));
    assert.ok(kinds.includes("ask_user"), "baseline question expected");
    const log = git(p.root, ["log", "--format=%s", "main"]);
    assert.match(log, /looprch: close P-001/);
    assert.match(log, /looprch\(P-001\): implementation/);
    assert.match(log, /looprch: baseline/);
    p.s.cleanup();
  });
});
