import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, copyFixture, initRepo, runCli, sandbox, writeExecutable, type Sandbox } from "../helpers/tmp.js";
import { installFakes, quotaJson } from "../helpers/fakes.js";

function project(): { s: Sandbox; proj: string } {
  const s = sandbox();
  installFakes(s);
  assert.equal(runCli(["install", "--from", REPO], { env: s.env }).code, 0);
  const proj = join(s.dir, "proj");
  initRepo(proj);
  copyFixture("notes-spec", proj);
  assert.equal(runCli(["add", proj, "--agents", "cursor,codex,opencode,kimi", "--yes"], { env: s.env }).code, 0);
  return { s, proj };
}

const byId = (r: any, id: string) => r.json.checks.find((c: any) => c.id === id);

describe("doctor and config", () => {
  test("doctor reports every check id with expected statuses", () => {
    const { s, proj } = project();
    writeFileSync(join(s.dir, "quota.json"), quotaJson([{ id: "codex", remaining: 50, resets_at: null }]));
    const r = runCli(["doctor", "--json"], { cwd: proj, env: { ...s.env, FAKE_QUOTA_FILE: join(s.dir, "quota.json") } });
    for (const id of ["node", "python", "git", "core_integrity", "shim_path", "layout_5x", "project_attached", "skill_links", "agents_md_block", "gitignore_block", "agent:codex:binary", "agent:codex:auth", "relay_duplicates", "quotalens", "sev3_package", "sev3_toolkit", "sev3_verify", "gates_ack", "git_repo", "git_identity", "git_clean", "roles_valid", "lock"])
      assert.ok(byId(r, id), `missing check ${id}`);
    assert.equal(byId(r, "core_integrity").status, "ok");
    assert.equal(byId(r, "sev3_verify").status, "ok");
    assert.equal(byId(r, "gates_ack").status, "warn");
    assert.equal(byId(r, "roles_valid").status, "fail");
    assert.equal(byId(r, "quotalens").status, "ok");
    assert.equal(r.code, 1);
    s.cleanup();
  });

  test("doctor --quick stays under 2 seconds", () => {
    const { s, proj } = project();
    const t = Date.now();
    const r = runCli(["doctor", "--quick", "--json"], { cwd: proj, env: s.env });
    assert.ok(r.json);
    assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
    assert.equal(byId(r, "quotalens").status, "skip");
    s.cleanup();
  });

  test("set-role persists, validates and regenerates subagent files", () => {
    const { s, proj } = project();
    const env = s.env;
    assert.equal(runCli(["config", "set", "lead_host", "cursor"], { cwd: proj, env }).code, 0);
    const a = runCli(["config", "set-role", "planner", "--mode", "direct", "--agent", "cursor", "--model", "m-plan", "--json"], { cwd: proj, env });
    assert.equal(a.code, 0, a.stdout);
    assert.ok(a.json.regenerated.includes(".cursor/agents/lr-planner.md"));
    assert.match(readFileSync(join(proj, ".cursor/agents/lr-planner.md"), "utf8"), /model: m-plan/);
    const bad = runCli(["config", "set-role", "tester", "--mode", "delegate", "--agent", "hermes", "--model", "x", "--json"], { cwd: proj, env });
    assert.equal(bad.json.error.code, "config_invalid");
    const oc = runCli(["config", "set-role", "implementer", "--mode", "delegate", "--agent", "opencode", "--model", "plain", "--json"], { cwd: proj, env });
    assert.match(oc.json.error.message, /provider\/model/);
    for (const [role, agent, model] of [["plan_debater", "kimi", "k"], ["implementer", "opencode", "p/m"], ["tester", "codex", "c"], ["reviewer", "cursor", "r"], ["worker", "kimi", "w"]])
      assert.equal(runCli(["config", "set-role", role!, "--mode", role === "reviewer" ? "direct" : "delegate", "--agent", agent!, "--model", model!], { cwd: proj, env }).code, 0);
    assert.equal(runCli(["config", "add-fallback", "implementer", "--mode", "delegate", "--agent", "codex", "--model", "c2"], { cwd: proj, env }).code, 0);
    const v = runCli(["config", "validate", "--json"], { cwd: proj, env });
    assert.equal(v.json.ok, true, JSON.stringify(v.json));
    assert.ok(v.json.warnings.some((w: string) => /read-only/.test(w)));
    const cfg = JSON.parse(readFileSync(join(proj, ".looprch/config.json"), "utf8"));
    assert.equal(cfg.roles.implementer.timeout, "2h");
    assert.equal(cfg.roles.implementer.fallbacks[0].agent, "codex");
    s.cleanup();
  });

  test("a missing relay fails validation and doctor names install-relay", () => {
    const { s, proj } = project();
    runCli(["config", "set-role", "tester", "--mode", "delegate", "--agent", "codex", "--model", "c"], { cwd: proj, env: s.env });
    rmSync(join(s.home, ".agents/skills/codex-delegate"), { recursive: true });
    const r = runCli(["doctor", "--quick", "--json"], { cwd: proj, env: s.env });
    assert.equal(byId(r, "relay:codex").status, "fail");
    assert.match(byId(r, "relay:codex").fix, /install-relay codex/);
    s.cleanup();
  });

  test("duplicate relay copies with different content warn", () => {
    const { s, proj } = project();
    runCli(["config", "set-role", "tester", "--mode", "delegate", "--agent", "codex", "--model", "c"], { cwd: proj, env: s.env });
    writeExecutable(join(s.home, ".codex/skills/codex-delegate/scripts/relay.mjs"), "// other copy\n");
    const r = runCli(["doctor", "--quick", "--json"], { cwd: proj, env: s.env });
    assert.equal(byId(r, "relay_duplicates").status, "warn");
    assert.match(byId(r, "relay_duplicates").summary, /\.codex\/skills/);
    s.cleanup();
  });

  test("install-relay runs the verified skills command through npx", () => {
    const { s, proj } = project();
    rmSync(join(s.home, ".agents/skills/kimi-delegate"), { recursive: true });
    writeExecutable(
      join(s.bin, "npx"),
      `#!/bin/sh\necho "$@" > ${join(s.dir, "npx.args")}\nmkdir -p "$HOME/.agents/skills/kimi-delegate/scripts" && echo "//" > "$HOME/.agents/skills/kimi-delegate/scripts/relay.mjs"\n`,
    );
    const r = runCli(["install-relay", "kimi", "--yes", "--json"], { cwd: proj, env: s.env });
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readFileSync(join(s.dir, "npx.args"), "utf8").trim(), "-y skills add amElnagdy/delegate-skills -g -y --copy --agent codex --skill kimi-delegate");
    s.cleanup();
  });

  test("models without delegate-setup explains the fallback", () => {
    const { s, proj } = project();
    const r = runCli(["models", "codex", "--json"], { cwd: proj, env: s.env });
    assert.equal(r.json.status, "failed");
    assert.match(r.json.error, /delegate-setup/);
    s.cleanup();
  });
});
