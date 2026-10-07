import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, initRepo, runCli, sandbox, type Sandbox } from "../helpers/tmp.js";

function setup(extra: NodeJS.ProcessEnv = {}): { s: Sandbox; proj: string } {
  const s = sandbox(extra);
  assert.equal(runCli(["install", "--from", REPO], { env: s.env }).code, 0);
  const proj = join(s.dir, "proj");
  initRepo(proj);
  return { s, proj };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const n of readdirSync(d)) {
      if (n === ".git") continue;
      const full = join(d, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[r] = `-> ${readlinkSync(full)}`;
      else if (st.isDirectory()) walk(full, r);
      else out[r] = readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

describe("looprch add / remove / list", () => {
  test("add twice gives an identical tree (idempotent)", () => {
    const { s, proj } = setup();
    const a = runCli(["add", proj, "--agents", "codex,opencode", "--yes", "--json"], { env: s.env });
    assert.equal(a.code, 0, a.stderr);
    const first = tree(proj);
    const b = runCli(["add", proj, "--agents", "codex,opencode", "--yes", "--json"], { env: s.env });
    assert.equal(b.code, 0);
    assert.deepEqual(b.json.added_agents, []);
    assert.deepEqual(b.json.files.created, []);
    assert.deepEqual(tree(proj), first);
    s.cleanup();
  });

  test("symlink mode links to LOOPRCH_HOME/current for agents that follow links", () => {
    const { s, proj } = setup();
    runCli(["add", proj, "--agents", "codex,opencode", "--yes"], { env: s.env });
    const link = readlinkSync(join(proj, ".agents/skills/lr-init"));
    assert.ok(link.startsWith(join(s.lrHome, "current")), link);
    assert.ok(existsSync(join(proj, ".opencode/commands/lr-init.md")));
    assert.match(readFileSync(join(proj, ".gitignore"), "utf8"), /\.agents\/skills\/lr-\*/);
    assert.match(readFileSync(join(proj, "AGENTS.md"), "utf8"), /<!-- looprch:begin -->/);
    s.cleanup();
  });

  test("an agent with unverified link support forces copy mode with a version stamp", () => {
    const { s, proj } = setup();
    const r = runCli(["add", proj, "--agents", "cursor", "--yes", "--json"], { env: s.env });
    assert.equal(r.json.link_mode[".agents/skills"], "copy");
    assert.equal(readFileSync(join(proj, ".agents/skills/lr-init/.looprch-version"), "utf8").trim(), "0.5.1");
    s.cleanup();
  });

  test("--copy forces copy mode and stays sticky", () => {
    const { s, proj } = setup();
    runCli(["add", proj, "--agents", "codex", "--yes", "--copy"], { env: s.env });
    assert.equal(lstatSync(join(proj, ".agents/skills/lr-init")).isSymbolicLink(), false);
    const r = runCli(["add", proj, "--agents", "opencode", "--yes", "--json"], { env: s.env });
    assert.equal(r.json.link_mode[".agents/skills"], "copy");
    s.cleanup();
  });

  test("adding a later agent keeps the existing ones", () => {
    const { s, proj } = setup();
    runCli(["add", proj, "--agents", "codex", "--yes"], { env: s.env });
    const r = runCli(["add", proj, "--agents", "codex,opencode", "--yes", "--json"], { env: s.env });
    assert.deepEqual(r.json.existing_agents, ["codex"]);
    assert.deepEqual(r.json.added_agents, ["opencode"]);
    assert.deepEqual(JSON.parse(readFileSync(join(proj, ".looprch/config.json"), "utf8")).agents, ["codex", "opencode"]);
    s.cleanup();
  });

  test("a broken link is repaired", () => {
    const { s, proj } = setup();
    runCli(["add", proj, "--agents", "codex", "--yes"], { env: s.env });
    const p = join(proj, ".agents/skills/lr-status");
    rmSync(p);
    symlinkSync(join(s.lrHome, "current/assets/skills/lr-gone"), p);
    const r = runCli(["add", proj, "--yes", "--json"], { env: s.env });
    assert.equal(r.code, 0);
    assert.ok(r.json.files.updated.includes(".agents/skills/lr-status"));
    assert.ok(existsSync(join(p, "SKILL.md")));
    s.cleanup();
  });

  test("a dangling Looprch link for a removed skill is deleted; foreign files are reported, not touched", () => {
    const { s, proj } = setup();
    mkdirSync(join(proj, ".agents/skills/lr-review"), { recursive: true });
    writeFileSync(join(proj, ".agents/skills/lr-review/SKILL.md"), "mine");
    mkdirSync(join(proj, ".agents/skills"), { recursive: true });
    symlinkSync(join(s.lrHome, "current/assets/skills/lr-obsolete"), join(proj, ".agents/skills/lr-obsolete"));
    const r = runCli(["add", proj, "--agents", "codex", "--yes", "--json"], { env: s.env });
    assert.ok(r.json.files.skipped_foreign.includes(".agents/skills/lr-review"));
    assert.equal(readFileSync(join(proj, ".agents/skills/lr-review/SKILL.md"), "utf8"), "mine");
    assert.ok(r.json.files.removed.includes(".agents/skills/lr-obsolete"));
    s.cleanup();
  });

  test("a foreign file at a generated path is skipped", () => {
    const { s, proj } = setup();
    mkdirSync(join(proj, ".opencode/commands"), { recursive: true });
    writeFileSync(join(proj, ".opencode/commands/lr-init.md"), "user file");
    const r = runCli(["add", proj, "--agents", "opencode", "--yes", "--json"], { env: s.env });
    assert.ok(r.json.files.skipped_foreign.includes(".opencode/commands/lr-init.md"));
    assert.equal(readFileSync(join(proj, ".opencode/commands/lr-init.md"), "utf8"), "user file");
    s.cleanup();
  });

  test("AGENTS.md user text around the block is preserved", () => {
    const { s, proj } = setup();
    writeFileSync(join(proj, "AGENTS.md"), "# My rules\n\nBe nice.\n");
    runCli(["add", proj, "--agents", "codex", "--yes"], { env: s.env });
    runCli(["add", proj, "--agents", "codex", "--yes"], { env: s.env });
    const text = readFileSync(join(proj, "AGENTS.md"), "utf8");
    assert.ok(text.startsWith("# My rules\n\nBe nice.\n"));
    assert.equal(text.split("<!-- looprch:begin -->").length, 2);
    s.cleanup();
  });

  test("a Looprch 5.x layout is refused", () => {
    const { s, proj } = setup();
    mkdirSync(join(proj, ".looprch/control"), { recursive: true });
    const r = runCli(["add", proj, "--agents", "codex", "--yes", "--json"], { env: s.env });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, "looprch5_layout");
    s.cleanup();
  });

  test("remove fails while a role uses the agent, succeeds after reassignment", () => {
    const { s, proj } = setup();
    runCli(["add", proj, "--agents", "codex,opencode", "--yes"], { env: s.env });
    const cfgPath = join(proj, ".looprch/config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.roles.reviewer = { mode: "delegate", agent: "opencode", model: "p/m", fallbacks: [] };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const r1 = runCli(["remove", "opencode", "--root", proj, "--json"], { env: s.env });
    assert.equal(r1.json.error.code, "agent_in_use");
    assert.deepEqual(r1.json.error.details.roles, ["reviewer"]);
    cfg.roles.reviewer.agent = "codex";
    cfg.roles.reviewer.model = "m";
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const r2 = runCli(["remove", "opencode", "--root", proj, "--json"], { env: s.env });
    assert.equal(r2.code, 0, r2.stdout);
    assert.ok(r2.json.removed_files.includes(".opencode/commands/lr-init.md"));
    assert.equal(existsSync(join(proj, ".opencode/commands/lr-init.md")), false);
    s.cleanup();
  });

  test("list shows the registered project", () => {
    const { s, proj } = setup();
    runCli(["add", proj, "--agents", "codex", "--yes"], { env: s.env });
    const r = runCli(["list", "--json"], { env: s.env });
    assert.equal(r.json[0].path, proj);
    assert.equal(r.json[0].exists, true);
    s.cleanup();
  });

  test("add without a central install explains how to install", () => {
    const s = sandbox();
    const proj = join(s.dir, "p");
    initRepo(proj);
    const r = runCli(["add", proj, "--agents", "codex", "--yes", "--json"], { env: s.env });
    assert.equal(r.json.error.code, "core_not_installed");
    s.cleanup();
  });
});
