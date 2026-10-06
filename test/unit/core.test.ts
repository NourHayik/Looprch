import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmp, REPO } from "../helpers/tmp.js";
import { writeFileAtomic, readJson } from "../../src/core/fsx.js";
import { acquireLock, releaseLock, readLock, withLock } from "../../src/core/lock.js";
import { appendEvent, lastSeq, progressStart, readEvents, renderProgress, takeProgress, EVENT_TYPES, type EventType, type LrEvent } from "../../src/core/journal.js";
import { defaultConfig, validateConfig, type AgentCaps, type AgentId, type Config, loadConfig, saveConfig } from "../../src/core/config.js";
import { migrate } from "../../src/core/migrations.js";
import { initialState, loadState, saveState } from "../../src/core/state.js";
import { projectPaths } from "../../src/core/paths.js";
import { LrError } from "../../src/core/errors.js";
import { formatDuration, reviewTimeout } from "../../src/core/clock.js";

const caps: Record<AgentId, AgentCaps> = {
  codex: { direct: true, delegate: true, readOnly: "enforced" },
  cursor: { direct: true, delegate: true, readOnly: "enforced" },
  agy: { direct: false, delegate: true, readOnly: "best-effort" },
  kimi: { direct: false, delegate: true, readOnly: "none" },
  hermes: { direct: false, delegate: false, readOnly: "none" },
  opencode: { direct: true, delegate: true, readOnly: "enforced", modelFormat: "provider/model" },
  grok: { direct: false, delegate: true, readOnly: "best-effort" },
};

function cfgWith(patch: (c: Config) => void): Config {
  const c = defaultConfig();
  c.agents = ["cursor", "codex", "kimi", "opencode", "hermes"];
  c.lead_host = "cursor";
  patch(c);
  return c;
}

describe("core/fsx", () => {
  test("atomic write replaces content and leaves no temp files", () => {
    const d = tmp();
    const f = join(d, "a.json");
    writeFileAtomic(f, "one");
    writeFileAtomic(f, "two");
    assert.equal(readFileSync(f, "utf8"), "two");
    assert.deepEqual(readdirSync(d), ["a.json"]);
  });

  test("a crash before rename keeps the old file intact", () => {
    const d = tmp();
    const f = join(d, "state.json");
    writeFileSync(f, '{"ok":1}');
    const script = `
      const fs = require("node:fs");
      const tmp = ${JSON.stringify(join(d, ".state.json.tmp-x"))};
      const fd = fs.openSync(tmp, "w"); fs.writeSync(fd, '{"partial":'); process.kill(process.pid, "SIGKILL");`;
    spawnSync(process.execPath, ["-e", script]);
    assert.deepEqual(readJson(f), { ok: 1 });
  });

  test("invalid JSON raises a typed error", () => {
    const d = tmp();
    writeFileSync(join(d, "x.json"), "{nope");
    assert.throws(() => readJson(join(d, "x.json")), (e: unknown) => e instanceof LrError && e.code === "invalid_json");
  });
});

describe("core/lock", () => {
  test("acquire and release", () => {
    const d = tmp();
    acquireLock(d, "cursor", "test");
    assert.equal(readLock(d)?.pid, process.pid);
    releaseLock(d);
    assert.equal(existsSync(projectPaths(d).lock), false);
  });

  test("a live holder makes a second process exit with code 3", async () => {
    const d = tmp();
    await withLock(d, "cursor", "holder", () => {
      const script = `import(${JSON.stringify(join(REPO, "build/src/core/lock.js"))}).then(m => { try { m.acquireLock(${JSON.stringify(d)}, null, "other", 0); process.exit(0) } catch (e) { process.exit(e.exitCode ?? 1) } })`;
      const r = spawnSync(process.execPath, ["-e", script]);
      assert.equal(r.status, 3);
    });
  });

  test("a stale pid on the same host is reclaimed", () => {
    const d = tmp();
    mkdirSync(projectPaths(d).lr, { recursive: true });
    writeFileSync(projectPaths(d).lock, JSON.stringify({ pid: 999999, hostname: hostname(), host_agent: null, command: "x", started: "", heartbeat: "" }));
    const reclaimed = acquireLock(d, null, "test");
    assert.equal(reclaimed, true);
    releaseLock(d);
  });

  test("a lock from another hostname is never reclaimed", () => {
    const d = tmp();
    mkdirSync(projectPaths(d).lr, { recursive: true });
    writeFileSync(projectPaths(d).lock, JSON.stringify({ pid: 999999, hostname: "elsewhere.invalid", host_agent: null, command: "x", started: "", heartbeat: "" }));
    assert.throws(() => acquireLock(d, null, "test"), (e: unknown) => e instanceof LrError && e.exitCode === 3);
  });
});

describe("core/journal", () => {
  test("events get increasing seq and can be filtered", () => {
    const d = tmp();
    appendEvent(d, { type: "phase.started", phase: "P-001" });
    appendEvent(d, { type: "stage.entered", phase: "P-001", stage: "planning" });
    appendEvent(d, { type: "phase.started", phase: "P-002" });
    const all = readEvents(d).events;
    assert.deepEqual(all.map((e) => e.seq), [1, 2, 3]);
    assert.equal(readEvents(d, { phase: "P-001" }).events.length, 2);
    assert.equal(readEvents(d, { limit: 1 }).events[0]!.phase, "P-002");
  });

  test("a truncated last line is ignored on read and replaced on append", () => {
    const d = tmp();
    appendEvent(d, { type: "phase.started", phase: "P-001" });
    appendFileSync(projectPaths(d).events, '{"v":1,"seq":2,"ty');
    const r = readEvents(d);
    assert.equal(r.events.length, 1);
    assert.equal(r.warnings.length, 1);
    const ev = appendEvent(d, { type: "paused" });
    assert.equal(ev.seq, 2);
    assert.equal(readEvents(d).warnings.length, 0);
  });

  test("schema enum matches the event type list", () => {
    const schema = JSON.parse(readFileSync(join(REPO, "schemas/events.schema.json"), "utf8"));
    assert.deepEqual([...schema.properties.type.enum].sort(), [...EVENT_TYPES].sort());
  });

  test("lastSeq reads the journal end", () => {
    const d = tmp();
    assert.equal(lastSeq(d), 0);
    appendEvent(d, { type: "phase.started", phase: "P-001" });
    appendEvent(d, { type: "paused" });
    assert.equal(lastSeq(d), 2);
  });
});

describe("core/journal progress lines", () => {
  let seq = 0;
  const ev = (type: EventType, rest: Partial<LrEvent> = {}): LrEvent => ({ v: 1, seq: ++seq, ts: "", type, phase: "P-003", stage: null, role: null, agent: null, run_id: null, data: {}, ...rest });

  test("phase, stage and run lines", () => {
    assert.deepEqual(
      renderProgress([
        ev("phase.started", { data: { title: "Tenant registry" } }),
        ev("stage.entered", { stage: "planning", data: { round: 0 } }),
        ev("run.issued", { role: "planner", agent: "codex", run_id: "P-003-planner-1", data: { task: "planning", mode: "delegate", mode_reason: "configured", model: "gpt", attempt: 1 } }),
        ev("result.accepted", { role: "planner", agent: "codex", run_id: "P-003-planner-1", data: { decision: "plan_ready", task: "planning", touched: 0 } }),
        ev("stage.entered", { stage: "debating", data: { round: 0 } }),
        ev("stage.entered", { stage: "repairing", data: { round: 2 } }),
        ev("phase.closed", { data: { tag: "looprch/P-003" } }),
      ]),
      [
        '[PHASE START] P-003 "Tenant registry"',
        "[PLANNING START] P-003 planning started.",
        "[TASK START] P-003-planner-1: Planner (planning) on codex/gpt · delegate",
        "[PLANNING COMPLETE] Initial plan completed by the Planner on codex: .looprch/phases/P-003/plan.md",
        "[DEBATE START] Plan sent for debate.",
        "[REPAIR START] Repair round 2 started.",
        "[PHASE COMPLETE] P-003 closed and merged (tag looprch/P-003).",
      ],
    );
  });

  test("debate outcomes", () => {
    const debate = (data: Record<string, unknown>) => renderProgress([ev("result.accepted", { role: "plan_debater", agent: "kimi", data: { task: "debate", ...data } })])[0];
    assert.equal(debate({ decision: "no_findings", findings_total: 0 }), "[DEBATE COMPLETE]\nResult: No changes recommended. Original plan accepted.");
    assert.equal(
      debate({ decision: "findings", findings_total: 5, severities: { high: 1, medium: 4 }, findings: [{ id: "D-1", severity: "high", summary: "Missing rollback." }, { id: "D-2", severity: "medium", summary: "Name the gate." }] }),
      "[DEBATE COMPLETE]\nResult: Changes recommended (5 findings: 1 high, 4 medium).\nSummary: D-1 (high): Missing rollback.; D-2 (medium): Name the gate.; 3 more",
    );
  });

  test("failures name the follow-up action", () => {
    const failed = ev("run.failed", { role: "tester", agent: "codex", run_id: "P-003-tester-1", data: { kind: "timeout", detail: "x\nrelay timed out after 60m\n" } });
    assert.equal(renderProgress([failed])[0], "[ISSUE]\nTask P-003-tester-1 (Tester on codex) failed.\nReason: timeout: relay timed out after 60m\nAction: Retry with the same agent.");
    const fallback = ev("assignment.changed", { role: "tester", agent: "kimi", data: { from: "codex/c", to: "kimi/k", reason: "run_failed_fallback" } });
    const lines = renderProgress([failed, fallback]);
    assert.match(lines[0]!, /Action: Switching the Tester to kimi\/k\.$/);
    assert.equal(lines[1], "[FALLBACK] Tester: codex/c replaced by kimi/k (run failed fallback).");
    const blocked = ev("blocked", { data: { code: "run_failed", reason: "tester failed 2 time(s)", hint: "Inspect the run" } });
    const b = renderProgress([failed, blocked]);
    assert.match(b[0]!, /Action: Looprch stopped; see \[BLOCKED\] below\.$/);
    assert.equal(b[1], "[BLOCKED]\nReason (run_failed): tester failed 2 time(s)\nFix: Inspect the run");
  });

  test("gates are summarized from their results; low-level events give no line", () => {
    const lines = renderProgress([
      ev("gate.result", { data: { gate_id: "G-1", ok: true } }),
      ev("gate.result", { data: { gate_id: "G-2", ok: false, reason: "exit 1" } }),
      ev("gates.run", { data: { all_passed: false } }),
      ev("todo.ticked", { data: { key: "P-003" } }),
      ev("quota.fallback", { data: {} }),
    ]);
    assert.deepEqual(lines, ["[GATES COMPLETE]\nResult: 1/2 gates passed.\nFailed: G-2 (exit 1)"]);
  });

  test("review lines name the round, time budget, origins and resolutions", () => {
    const lines = renderProgress([
      ev("run.issued", { role: "reviewer", agent: "codex", run_id: "P-003-reviewer-2", data: { task: "review", mode: "delegate", mode_reason: "configured", model: "gpt", attempt: 1, timeout: "90m", review_round: 2, review_cap: 3 } }),
      ev("result.accepted", {
        role: "reviewer",
        agent: "codex",
        data: { task: "review", decision: "changes_requested", review_round: 2, review_cap: 3, findings_total: 2, severities: { high: 1, medium: 1 }, findings: [{ id: "R-2", severity: "high", origin: "unfixed", summary: "still open" }, { id: "R-11", severity: "medium", origin: "regression", summary: "broke" }] },
      }),
      ev("result.accepted", { role: "implementer", agent: "cursor", data: { task: "repair", decision: "implemented", touched: 3, resolutions: [{ id: "R-2", status: "fixed" }, { id: "R-11", status: "not_fixed" }] } }),
    ]);
    assert.equal(lines[0], "[TASK START] P-003-reviewer-2: Reviewer (review) on codex/gpt · delegate · review round 2 of 3 · time budget 90m");
    assert.equal(lines[1], "[REVIEW COMPLETE] (review round 2 of 3)\nResult: Changes requested (2 findings: 1 high, 1 medium).\nOrigin: 1 unfixed, 1 regression\nFindings: R-2 (high): still open; R-11 (medium): broke");
    assert.equal(lines[2], "[REPAIR COMPLETE] The Implementer on cursor finished; 3 files touched. Resolutions: 1 fixed, not fixed: R-11.");
  });

  test("review timeouts grow with each round", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => reviewTimeout("60m", n)), ["60m", "90m", "2h", "150m"]);
    assert.equal(reviewTimeout("45s", 2), "68s");
    assert.equal(formatDuration(5_400_000), "90m");
  });

  test("events written before 0.2.0 still render", () => {
    assert.deepEqual(renderProgress([ev("result.accepted", { role: "tester", agent: "codex", run_id: "P-003-tester-1", data: { decision: "pass" } })]), ["[TASK COMPLETE] P-003-tester-1: Tester on codex returned pass."]);
  });
});

describe("core/journal progress cursor", () => {
  test("without a cursor reporting starts at the journal end; each event is reported once", () => {
    const d = tmp();
    appendEvent(d, { type: "phase.started", phase: "P-001", data: { title: "Old" } });
    const from = progressStart(d);
    assert.equal(from, 1);
    appendEvent(d, { type: "paused" });
    assert.deepEqual(takeProgress(d, from), ["[PAUSED] Looprch paused at your request."]);
    assert.deepEqual(readJson(projectPaths(d).progress), { reported_seq: 2 });
    assert.equal(progressStart(d, 0), 2);
    assert.deepEqual(takeProgress(d, progressStart(d)), []);
  });

  test("an unreadable cursor falls back", () => {
    const d = tmp();
    appendEvent(d, { type: "paused" });
    writeFileAtomic(projectPaths(d).progress, "{nope");
    assert.equal(progressStart(d), 1);
    assert.equal(progressStart(d, 0), 0);
  });
});

describe("core/config", () => {
  test("default config with valid roles passes", () => {
    const c = cfgWith((c) => {
      c.roles.planner = { mode: "direct", agent: "cursor", model: "m", fallbacks: [{ mode: "delegate", agent: "codex", model: "x" }] };
      c.roles.implementer = { mode: "delegate", agent: "opencode", model: "p/m", fallbacks: [] };
    });
    const r = validateConfig(c, { caps });
    assert.deepEqual(r.errors, []);
  });

  test("disabled agent is an error", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.tester = { mode: "delegate", agent: "grok", model: "m", fallbacks: [] })), { caps });
    assert.match(r.errors.join(), /not enabled/);
  });

  test("hermes cannot be a delegate target", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.tester = { mode: "delegate", agent: "hermes", model: "m", fallbacks: [] })), { caps });
    assert.match(r.errors.join(), /no delegate relay/);
  });

  test("direct on an agent without Direct support is an error", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.tester = { mode: "direct", agent: "kimi", model: "m", fallbacks: [] })), { caps });
    assert.match(r.errors.join(), /Direct/);
  });

  test("direct on another host than lead_host only warns (D-05)", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.reviewer = { mode: "direct", agent: "codex", model: "m", fallbacks: [] })), { caps });
    assert.deepEqual(r.errors, []);
    assert.match(r.warnings.join(), /D-05/);
  });

  test("read-only role on a relay without read-only warns", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.reviewer = { mode: "delegate", agent: "kimi", model: "m", fallbacks: [] })), { caps });
    assert.match(r.warnings.join(), /read-only/);
  });

  test("worker max_parallel range", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.worker = { mode: "delegate", agent: "codex", model: "m", fallbacks: [], max_parallel: 9 })), { caps });
    assert.match(r.errors.join(), /max_parallel/);
  });

  test("unknown role and missing model", () => {
    const c = cfgWith(() => {}) as any;
    c.roles.manager = { mode: "delegate", agent: "codex", model: "m", fallbacks: [] };
    c.roles.tester = { mode: "delegate", agent: "codex", model: "", fallbacks: [] };
    const r = validateConfig(c, { caps });
    assert.match(r.errors.join(), /unknown role/);
    assert.match(r.errors.join(), /never invents/);
  });

  test("opencode model must be provider/model", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.implementer = { mode: "delegate", agent: "opencode", model: "plain", fallbacks: [] })), { caps });
    assert.match(r.errors.join(), /provider\/model/);
  });

  test("missing relay is an error when the context can check", () => {
    const r = validateConfig(cfgWith((c) => (c.roles.tester = { mode: "delegate", agent: "codex", model: "m", fallbacks: [] })), { caps, relayExists: () => false });
    assert.match(r.errors.join(), /install-relay/);
  });

  test("gates.env names are validated", () => {
    const r = validateConfig(cfgWith((c) => (c.gates.env = { "bad-name": "x" })), { caps });
    assert.match(r.errors.join(), /gates.env/);
  });

  test("schema required keys match the default config", () => {
    const schema = JSON.parse(readFileSync(join(REPO, "schemas/config.schema.json"), "utf8"));
    assert.deepEqual([...schema.required].sort(), Object.keys(defaultConfig()).sort());
  });

  test("save and load round-trip", () => {
    const d = tmp();
    const c = cfgWith(() => {});
    saveConfig(d, c);
    assert.deepEqual(loadConfig(d), c);
  });
});

describe("core/migrations", () => {
  test("synthetic v0 to v1 migration writes a backup", () => {
    const d = tmp();
    const src = join(d, "config.json");
    writeFileSync(src, "{}");
    const out = migrate({ old: true }, "config", 1, [{ from: 0, up: (doc) => ({ ...doc, migrated: true }) }], join(d, "backups"), src);
    assert.equal(out.schema_version, 1);
    assert.equal(out.migrated, true);
    assert.equal(readdirSync(join(d, "backups")).length, 1);
    assert.equal(readJson<any>(src).migrated, true);
  });

  test("a newer schema refuses with update advice", () => {
    assert.throws(() => migrate({ schema_version: 9 }, "state", 1, [], null, null), (e: unknown) => e instanceof LrError && e.code === "schema_too_new");
  });
});

describe("core/state", () => {
  test("save and load round-trip; missing file gives the initial state", () => {
    const d = tmp();
    assert.deepEqual(loadState(d), initialState());
    const s = initialState();
    s.scope = "auto";
    saveState(d, s);
    assert.equal(loadState(d).scope, "auto");
  });

  test("schema required keys match the initial state", () => {
    const schema = JSON.parse(readFileSync(join(REPO, "schemas/state.schema.json"), "utf8"));
    assert.deepEqual([...schema.required].sort(), Object.keys(initialState()).sort());
  });
});
