import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../helpers/tmp.js";

test("unknown command exits 2", () => {
  const r = runCli(["no-such-command"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command/);
});

test("version --json has every field", () => {
  const r = runCli(["version", "--json"]);
  assert.equal(r.code, 0);
  for (const k of ["version", "protocol", "toolkit_version", "node", "platform", "home"]) assert.ok(k in r.json, k);
  assert.equal(r.json.version, "0.5.2");
  assert.equal(r.json.toolkit_version, "1.2.0");
});

test("unknown flag is a usage error with exit 2", () => {
  const r = runCli(["version", "--bogus", "--json"]);
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, "usage");
});

test("no command prints usage and exits 2", () => {
  const r = runCli([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /Usage: looprch/);
});
