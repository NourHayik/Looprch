import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, runCli, sandbox, writeExecutable } from "../helpers/tmp.js";
import { makePackage } from "../helpers/pkg.js";
import { packageSpec } from "../../src/cli/update.js";

describe("install / update / rollback / uninstall", () => {
  test("install from a checkout writes versions, current and the shim", () => {
    const s = sandbox();
    const r = runCli(["install", "--from", REPO, "--json"], { env: s.env });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.version, "0.4.0");
    assert.equal(readlinkSync(join(s.lrHome, "current")), "versions/0.4.0");
    assert.ok(existsSync(join(s.lrHome, "versions/0.4.0/dist/looprch.mjs")));
    assert.match(readFileSync(join(s.home, ".local/bin/looprch"), "utf8"), /looprch shim/);
    assert.equal(r.json.on_path, false);
    assert.match(r.json.path_hint, /\.local\/bin/);
    const v = spawnSync(join(s.home, ".local/bin/looprch"), ["version"], { env: { ...process.env, ...s.env }, encoding: "utf8" });
    assert.match(v.stdout, /looprch 0\.4\.0/);
    s.cleanup();
  });

  test("install twice is idempotent", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    const r = runCli(["install", "--from", REPO, "--json"], { env: s.env });
    assert.equal(r.json.reused, true);
    s.cleanup();
  });

  test("a manifest mismatch is rejected and current is unchanged", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    const bad = makePackage("0.5.0");
    appendFileSync(join(bad, "assets/templates/agents-md-block.md"), "tampered");
    const r = runCli(["install", "--from", bad, "--json"], { env: s.env });
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, "manifest_mismatch");
    assert.equal(readlinkSync(join(s.lrHome, "current")), "versions/0.4.0");
    s.cleanup();
  });

  test("update switches, keeps the previous version and rollback returns", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    const pkg = makePackage("0.5.0");
    const u = runCli(["update", "--from", pkg, "--yes", "--json"], { env: s.env });
    assert.equal(u.code, 0, u.stdout + u.stderr);
    assert.equal(u.json.from, "0.4.0");
    assert.equal(u.json.to, "0.5.0");
    assert.equal(readlinkSync(join(s.lrHome, "current")), "versions/0.5.0");
    assert.ok(existsSync(join(s.lrHome, "versions/0.4.0")));
    const rb = runCli(["rollback", "--json"], { env: s.env });
    assert.equal(rb.code, 0);
    assert.equal(rb.json.to, "0.4.0");
    assert.equal(readlinkSync(join(s.lrHome, "current")), "versions/0.4.0");
    s.cleanup();
  });

  test("a failing self-test leaves current unchanged", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    const pkg = makePackage("0.6.0", (dir) => appendFileSync(join(dir, "vendor/sev3-toolkit/1.2.0/sev3lib.py"), "\n# tampered\n"));
    const u = runCli(["update", "--from", pkg, "--yes", "--json"], { env: s.env });
    assert.equal(u.code, 1);
    assert.equal(u.json.error.code, "self_test_failed");
    assert.equal(readlinkSync(join(s.lrHome, "current")), "versions/0.4.0");
    s.cleanup();
  });

  test("prune keeps two versions", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    for (const v of ["0.5.0", "0.6.0", "0.7.0"]) assert.equal(runCli(["update", "--from", makePackage(v), "--yes"], { env: s.env }).code, 0);
    const versions = spawnSync("ls", [join(s.lrHome, "versions")], { encoding: "utf8" }).stdout.trim().split("\n");
    assert.deepEqual(versions, ["0.6.0", "0.7.0"]);
    s.cleanup();
  });

  test("uninstall removes home and shim but keeps project folders", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    const proj = join(s.dir, "proj");
    mkdirSync(join(proj, ".looprch"), { recursive: true });
    writeFileSync(join(proj, ".looprch/keep.json"), "{}");
    const r = runCli(["uninstall", "--yes", "--json"], { env: s.env });
    assert.equal(r.code, 0);
    assert.equal(existsSync(s.lrHome), false);
    assert.equal(existsSync(join(s.home, ".local/bin/looprch")), false);
    assert.ok(existsSync(join(proj, ".looprch/keep.json")));
    s.cleanup();
  });

  test("uninstall without --yes and without a terminal is a usage error", () => {
    const s = sandbox();
    runCli(["install", "--from", REPO], { env: s.env });
    const r = runCli(["uninstall", "--json"], { env: s.env });
    assert.equal(r.code, 2);
    assert.ok(existsSync(s.lrHome));
    s.cleanup();
  });

  test("install.sh refuses an old node", () => {
    const s = sandbox();
    writeExecutable(join(s.bin, "node"), '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 20; else echo v20.0.0; fi\n');
    const r = spawnSync("sh", [join(REPO, "install.sh")], { env: { ...process.env, PATH: `${s.bin}:/usr/bin:/bin` }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Node\.js 22 or newer/);
    s.cleanup();
  });

  for (const [label, published, version, expected] of [
    ["npm registry", true, "0.1.0", "npx -y looprch@0.1.0 install"],
    ["GitHub when not on npm", false, "", "npx -y github:NourHayik/Looprch install"],
    ["GitHub tag for a pinned version", false, "0.1.0", "npx -y github:NourHayik/Looprch#v0.1.0 install"],
  ] as const) {
    test(`install.sh uses the ${label}`, () => {
      const s = sandbox();
      writeExecutable(join(s.bin, "npx"), `#!/bin/sh\necho "npx $*" > ${join(s.dir, "npx.log")}\n`);
      writeExecutable(join(s.bin, "npm"), `#!/bin/sh\n${published ? "echo 0.1.0" : "exit 1"}\n`);
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${s.bin}:${process.env.PATH}` };
      if (version) env.LOOPRCH_VERSION = version;
      else delete env.LOOPRCH_VERSION;
      const r = spawnSync("sh", [join(REPO, "install.sh")], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(join(s.dir, "npx.log"), "utf8").trim(), expected);
      s.cleanup();
    });
  }

  test("update falls back to the GitHub repository when looprch is not on npm", () => {
    assert.equal(packageSpec(undefined, true), "looprch@latest");
    assert.equal(packageSpec("0.4.0", true), "looprch@0.4.0");
    assert.equal(packageSpec(undefined, false), "github:NourHayik/Looprch");
    assert.equal(packageSpec("0.4.0", false), "github:NourHayik/Looprch#v0.4.0");
  });
});
