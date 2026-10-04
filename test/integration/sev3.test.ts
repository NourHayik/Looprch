import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { REPO, copyFixture, initRepo, runCli, sandbox, type Sandbox } from "../helpers/tmp.js";
import { buildPacket } from "../../src/sev3/packets.js";
import { tick } from "../../src/sev3/todo.js";
import { verifyPackage } from "../../src/sev3/fingerprint.js";

function project(): { s: Sandbox; proj: string } {
  const s = sandbox();
  assert.equal(runCli(["install", "--from", REPO], { env: s.env }).code, 0);
  const proj = join(s.dir, "proj");
  initRepo(proj);
  copyFixture("notes-spec", proj);
  assert.equal(runCli(["add", proj, "--agents", "codex", "--yes"], { env: s.env }).code, 0);
  return { s, proj };
}

describe("SEV3 integration", () => {
  test("discover on the fixture is ok, trusted and verified (not application-verified)", () => {
    const { s, proj } = project();
    const r = runCli(["init", "discover", "--json"], { cwd: proj, env: s.env });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.toolkit_trusted, true);
    assert.equal(r.json.verify.ok, true);
    assert.equal(r.json.verify.application_verified, false);
    assert.equal(r.json.phases.length, 3);
    assert.equal(r.json.closure_phase, "P-003");
    assert.equal(r.json.package_fingerprint, JSON.parse(readFileSync(join(proj, "phases/package-lock.json"), "utf8")).fingerprint);
    assert.match(r.json.source_fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.json.gate_commands, [{ argv0: "python3", count: 3 }]);
    assert.equal(r.json.gates_acknowledged, false);
    const state = JSON.parse(readFileSync(join(proj, ".looprch/state.json"), "utf8"));
    assert.equal(state.spec.phases_total, 3);
    s.cleanup();
  });

  test("ack-gates records the manifest hash; a wrong hash is refused", () => {
    const { s, proj } = project();
    const d = runCli(["init", "discover", "--json"], { cwd: proj, env: s.env });
    const bad = runCli(["init", "ack-gates", "--manifest-sha256", "0".repeat(64), "--json"], { cwd: proj, env: s.env });
    assert.equal(bad.json.error.code, "manifest_changed");
    const ok = runCli(["init", "ack-gates", "--manifest-sha256", d.json.manifest_sha256, "--json"], { cwd: proj, env: s.env });
    assert.equal(ok.code, 0);
    assert.equal(runCli(["init", "discover", "--json"], { cwd: proj, env: s.env }).json.gates_acknowledged, true);
    s.cleanup();
  });

  test("a tampered toolkit file is untrusted", () => {
    const { s, proj } = project();
    appendFileSync(join(proj, "phases/tools/sev3lib.py"), "\n# changed\n");
    const r = runCli(["init", "discover", "--json"], { cwd: proj, env: s.env });
    assert.equal(r.code, 1);
    assert.equal(r.json.toolkit_trusted, false);
    assert.ok(r.json.tool_mismatches.includes("phases/tools/sev3lib.py"));
    s.cleanup();
  });

  test("a changed phase source fails verification", () => {
    const { s, proj } = project();
    appendFileSync(join(proj, "phases/en/P-002.md"), "\nextra\n");
    const r = runCli(["init", "discover", "--json"], { cwd: proj, env: s.env });
    assert.equal(r.json.verify.ok, false);
    assert.match(r.json.verify.error, /Package changed since seal|stale/);
    s.cleanup();
  });

  test("a package in a subfolder gives the root-only error", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    const proj = join(s.dir, "proj");
    initRepo(proj);
    mkdirSync(join(proj, "spec"));
    copyFixture("notes-spec", join(proj, "spec"));
    runCli(["add", proj, "--agents", "codex", "--yes"], { env: s.env });
    const r = runCli(["init", "discover", "--json"], { cwd: proj, env: s.env });
    assert.equal(r.json.error.code, "package_in_subfolder");
    s.cleanup();
  });

  test("planner packet is written under .looprch/packets; expansion needs a reason", () => {
    const { s, proj } = project();
    const p = buildPacket(proj, "P-001", "planner");
    assert.equal(p.path, ".looprch/packets/P-001/planner.md");
    assert.ok(p.bytes > 1000);
    assert.ok(existsSync(join(proj, p.path)));
    assert.throws(() => buildPacket(proj, "P-001", "planner", { documents: ["F-NOTES"] }), /question and reason/);
    const e = buildPacket(proj, "P-001", "planner", { documents: ["R-OPERATIONS"], question: "q?", reason: "r" });
    assert.equal(e.path, ".looprch/packets/P-001/planner-exp-1.md");
    assert.throws(() => buildPacket(proj, "P-001", "implementer", { documents: ["F-NOTES"], question: "q", reason: "r" }), /through the Planner/);
    s.cleanup();
  });

  test("ticking todo keeps the package verified", () => {
    const { s, proj } = project();
    tick(proj, "P-001:implementation");
    tick(proj, "P-001");
    assert.equal(verifyPackage(proj).ok, true);
    s.cleanup();
  });

  test("a non-sev3 manifest is rejected", () => {
    const { s, proj } = project();
    renameSync(join(proj, "phases/manifest.json"), join(proj, "phases/m.json"));
    const r = runCli(["init", "discover", "--json"], { cwd: proj, env: s.env });
    assert.equal(r.json.error.code, "no_package");
    s.cleanup();
  });
});
