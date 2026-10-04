import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sandbox, type Sandbox } from "../helpers/tmp.js";
import { installFakes } from "../helpers/fakes.js";
import { resolveMode } from "../../src/core/mode.js";
import { buildRelayArgv } from "../../src/delegate/dispatch.js";
import { parseRelayResult } from "../../src/delegate/result.js";
import { recordSession, resumableSession, sessionKey, forgetSession } from "../../src/delegate/sessions.js";
import { initialState } from "../../src/core/state.js";
import type { RunRecord } from "../../src/core/runs.js";
import type { RelayInfo } from "../../src/delegate/locate.js";

let s: Sandbox;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH };

before(() => {
  s = sandbox();
  installFakes(s, ["codex", "cursor", "kimi", "opencode", "agy"]);
  process.env.HOME = s.home;
  process.env.PATH = `${s.bin}:/usr/bin:/bin`;
});
after(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  s.cleanup();
});

describe("mode resolution (D-04, D-05)", () => {
  test("direct on the current host stays direct", () => {
    const m = resolveMode("/x", { mode: "direct", agent: "cursor", model: "m" }, "cursor");
    assert.deepEqual(m.ok && [m.mode, m.reason], ["direct", "configured"]);
  });
  test("direct on another host runs through that agent's relay with the same model", () => {
    const m = resolveMode("/x", { mode: "direct", agent: "cursor", model: "m" }, "codex");
    assert.ok(m.ok);
    assert.equal(m.mode, "delegate");
    assert.equal(m.reason, "d05_auto_delegate");
  });
  test("direct on another host without a relay stops with a message", () => {
    const m = resolveMode("/x", { mode: "direct", agent: "grok", model: "m" }, "codex");
    assert.equal(m.ok, false);
    assert.equal(!m.ok && m.code, "relay_missing");
  });
  test("hermes cannot be delegated to", () => {
    const m = resolveMode("/x", { mode: "direct", agent: "hermes", model: "m" }, "cursor");
    assert.equal(!m.ok && m.code, "delegate_unsupported");
  });
  test("a delegate role without the CLI binary is cli_missing", () => {
    process.env.PATH = "/usr/bin:/bin";
    try {
      const m = resolveMode("/x", { mode: "delegate", agent: "codex", model: "m" }, "cursor");
      assert.equal(!m.ok && m.code, "cli_missing");
    } finally {
      process.env.PATH = `${s.bin}:/usr/bin:/bin`;
    }
  });
});

function run(over: Partial<RunRecord>): RunRecord {
  return {
    run_id: "P-001-tester-1", phase: "P-001", stage: "testing", task: "testing", role: "tester", mode: "delegate", effective_mode: "delegate", mode_reason: "configured",
    agent: "codex", model: "m1", effort: null, timeout: "60m", session_in: null, resume: false, attempt: 1, status: "issued", side: false, read_only: false,
    packet: null, brief: ".looprch/runs/P-001-tester-1/brief.md", pid: null, relay_path: null, relay_sha256: null, argv: null, started_at: "", finished_at: null,
    git_before: null, git_after: null, touched_files: [], session_out: null, decision: null, ...over,
  };
}
const relay = (agent: string): RelayInfo => ({ agent: agent as any, skill: `${agent}-delegate`, path: `/r/${agent}/relay.mjs`, version: "0.5.0", sha256: "x", found_at: "", duplicates: [] });

describe("relay argv", () => {
  test("codex: effort, read-only, session, clean-env", () => {
    const { argv } = buildRelayArgv("/p", run({ agent: "codex", effort: "high", read_only: true, resume: true, session_in: "t1" }), relay("codex"));
    assert.deepEqual(argv, ["/r/codex/relay.mjs", "--brief", "/p/.looprch/runs/P-001-tester-1/brief.md", "--cd", "/p", "--out-dir", join("/p", ".looprch/runs/P-001-tester-1/relay"), "--timeout", "60m", "--model", "m1", "--effort", "high", "--read-only", "--session", "t1", "--clean-env"]);
  });
  test("opencode uses --variant; agy uses --conversation", () => {
    assert.ok(buildRelayArgv("/p", run({ agent: "opencode", effort: "max" }), relay("opencode")).argv.join(" ").includes("--variant max"));
    assert.ok(buildRelayArgv("/p", run({ agent: "agy", resume: true, session_in: "c9" }), relay("agy")).argv.join(" ").includes("--conversation c9"));
  });
  test("kimi gets no read-only flag; cursor drops effort with a warning; never --lane or --resume-last", () => {
    const k = buildRelayArgv("/p", run({ agent: "kimi", read_only: true }), relay("kimi"));
    assert.ok(!k.argv.includes("--read-only"));
    assert.match(k.warnings[0]!, /cannot run read-only/);
    const c = buildRelayArgv("/p", run({ agent: "cursor", effort: "high" }), relay("cursor"));
    assert.ok(!c.argv.includes("--effort"));
    assert.match(c.warnings[0]!, /no effort flag/);
    for (const x of [k, c]) assert.ok(!x.argv.includes("--lane") && !x.argv.includes("--resume-last") && !x.argv.includes("--clean-env"));
  });
});

describe("relay results and sessions", () => {
  test("status mapping and session fields per adapter", () => {
    assert.equal(parseRelayResult({ status: "codex_unavailable" }).status, "unavailable");
    assert.equal(parseRelayResult({ status: "completed", threadId: "t" }, "threadId").sessionId, "t");
    assert.equal(parseRelayResult({ status: "completed", conversationId: "c" }, "conversationId").sessionId, "c");
    assert.equal(parseRelayResult({ status: "completed", readOnlyViolation: true }).readOnlyViolation, true);
    assert.throws(() => parseRelayResult({ schema: "other.v9" }));
  });
  test("session keys reuse within a phase; non-resumable or lost sessions are not resumed", () => {
    const st = initialState();
    const k = sessionKey("P-001", "implementer", "opencode");
    assert.equal(resumableSession(st, k), null);
    recordSession(st, k, "ses_1", "delegate", true, "r1");
    assert.equal(resumableSession(st, k), "ses_1");
    assert.equal(resumableSession(st, sessionKey("P-002", "implementer", "opencode")), null, "each phase starts fresh");
    forgetSession(st, k);
    assert.equal(resumableSession(st, k), null);
    recordSession(st, k, null, "delegate", true, "r2");
    assert.equal(resumableSession(st, k), null);
  });
});
