#!/usr/bin/env node
// Fake TesterArmy `e2e` CLI for Looprch tests. Speaks the subset Looprch uses (spike S-11):
// `--version`, `list --reporter json`, `run --config <f> --reporter list,junit --output <dir>`.
// Behaviour: FAKE_E2E_EXIT (exit code of `run`; 1 writes a failing junit.xml, 0 a passing one),
// FAKE_E2E_FAIL_TIMES (fail the first N runs with exit 1, then pass), FAKE_E2E_SLEEP_MS,
// FAKE_E2E_NO_REPORT (exit 0 without junit.xml), FAKE_E2E_NO_TESTS (list selects nothing).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const log = process.env.FAKE_E2E_LOG;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`);
if (args[0] === "--version") {
  process.stdout.write("0.18.0\n");
  process.exit(0);
}
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args[0] === "list") {
  if (!existsSync(opt("--config") ?? "e2e.config.ts")) {
    process.stderr.write("INVALID_CONFIG: config not found\n");
    process.exit(2);
  }
  const pairs = process.env.FAKE_E2E_NO_TESTS ? [] : [{ file: "tests/home.e2e.ts", title: "home shows ready", titlePath: ["home shows ready"], kind: "test", tags: [], target: "web", disposition: "run" }];
  process.stdout.write(`${JSON.stringify({ pairs }, null, 2)}\n`);
  process.exit(0);
}
if (args[0] !== "run") {
  process.stderr.write(`unknown command ${args[0]}\n`);
  process.exit(2);
}
if (process.env.FAKE_E2E_SLEEP_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_E2E_SLEEP_MS)));
let code = Number(process.env.FAKE_E2E_EXIT ?? "0");
const counter = process.env.FAKE_E2E_COUNTER;
if (counter && process.env.FAKE_E2E_FAIL_TIMES) {
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  code = n < Number(process.env.FAKE_E2E_FAIL_TIMES) ? 1 : 0;
}
if (code === 2 || code === 3) {
  process.stderr.write(code === 2 ? "INVALID_CONFIG: unknown key\n" : "ENVIRONMENT_UNAVAILABLE: app did not start\n");
  process.exit(code);
}
const out = opt("--output") ?? ".e2e";
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "report.json"), JSON.stringify({ schemaVersion: "report-1", run: { status: code === 0 ? "passed" : "failed" } }));
if (!process.env.FAKE_E2E_NO_REPORT) {
  const failure = code === 1 ? '<failure message="expected status to contain ready">AssertionError</failure>' : "";
  writeFileSync(
    join(out, "junit.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="e2e" tests="1" failures="${code === 1 ? 1 : 0}" errors="0" skipped="0" time="0.4">\n  <testsuite name="tests/home.e2e.ts" tests="1" failures="${code === 1 ? 1 : 0}" errors="0" skipped="0" time="0.4">\n    <testcase name="home shows ready [web]" classname="tests/home.e2e.ts" time="0.4">${failure}</testcase>\n  </testsuite>\n</testsuites>\n`,
  );
}
process.stdout.write(code === 0 ? " ✓ home shows ready\n Tests 1 passed (1)\n" : " ✗ home shows ready\n Tests 1 failed (1)\n");
process.exit(code);
