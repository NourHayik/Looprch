import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../helpers/tmp.js";
import { tickText } from "../../src/sev3/todo.js";
import { gateCommands } from "../../src/sev3/discovery.js";
import { relatedPhaseIds, type Manifest } from "../../src/sev3/manifest.js";
import { verifySums, sha256File } from "../../src/install/manifest.js";

const TODO = `# Implementation TODO

- [ ] P-001 - Identifier foundation
  - [ ] P-001:implementation
  - [ ] P-001:gate:GATE-P-001-negative
  - [ ] P-001:handover

- [ ] P-0011 - Other
  - [ ] P-0011:implementation

- [ ] PROJECT:production-readiness
`;

describe("sev3/todo", () => {
  test("ticks exactly one line and nothing else", () => {
    const r = tickText(TODO, "P-001:implementation");
    assert.equal(r.changed, true);
    const diff = r.text.split("\n").filter((l, i) => l !== TODO.split("\n")[i]);
    assert.deepEqual(diff, ["  - [x] P-001:implementation"]);
  });

  test("phase line key does not match a longer phase id", () => {
    const r = tickText(TODO, "P-001");
    assert.match(r.text, /^- \[x\] P-001 - Identifier foundation$/m);
    assert.match(r.text, /^- \[ \] P-0011 - Other$/m);
  });

  test("ticking twice is a no-op", () => {
    const once = tickText(TODO, "P-001:gate:GATE-P-001-negative").text;
    const twice = tickText(once, "P-001:gate:GATE-P-001-negative");
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once);
  });

  test("a missing line is an error; invalid keys are refused", () => {
    assert.throws(() => tickText(TODO, "P-002:handover"), /no line/);
    assert.throws(() => tickText(TODO, "anything"), /Invalid todo key/);
  });

  test("PROJECT key", () => {
    assert.match(tickText(TODO, "PROJECT:production-readiness").text, /- \[x\] PROJECT:production-readiness/);
  });
});

describe("sev3/manifest helpers", () => {
  const m = JSON.parse(readFileSync(join(REPO, "test/fixtures/notes-spec/phases/manifest.json"), "utf8")) as Manifest;

  test("gate command summary", () => {
    assert.deepEqual(gateCommands(m), [{ argv0: "python3", count: 3 }]);
  });

  test("related phases: requires, related and producers of used documents", () => {
    assert.deepEqual(relatedPhaseIds(m, m.phases[1]!), ["P-001"]);
    assert.deepEqual(relatedPhaseIds(m, m.phases[2]!), ["P-001", "P-002"]);
    assert.deepEqual(relatedPhaseIds(m, m.phases[0]!), ["P-002"]);
  });
});

describe("vendored toolkit", () => {
  const vendor = join(REPO, "vendor/sev3-toolkit/1.2.0");
  test("hashes equal SHA256SUMS", () => {
    const r = verifySums(vendor);
    assert.equal(r.ok, true, r.mismatched.join());
    assert.equal(r.expected["sev3lib.py"], "7436495252004c4865b018821b376436da7cac93f00f6d50135348dfaef390ab");
  });

  const sev3Tools = join(REPO, "sev3/assets/package/phases/tools");
  test("vendored files equal the SEV3 skill's toolkit", { skip: !existsSync(sev3Tools) && "sev3/ not present" }, () => {
    for (const f of ["sev3lib.py", "specctl.py", "phase_context.py", "verify_package.py", "VERSION"]) assert.equal(sha256File(join(vendor, f)), sha256File(join(sev3Tools, f)), f);
  });
});
