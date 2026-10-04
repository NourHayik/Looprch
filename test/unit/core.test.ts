import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmp, REPO } from "../helpers/tmp.js";
import { writeFileAtomic, readJson } from "../../src/core/fsx.js";
import { acquireLock, releaseLock, readLock, withLock } from "../../src/core/lock.js";
import { appendEvent, readEvents, EVENT_TYPES } from "../../src/core/journal.js";
import { defaultConfig, validateConfig, type AgentCaps, type AgentId, type Config, loadConfig, saveConfig } from "../../src/core/config.js";
import { migrate } from "../../src/core/migrations.js";
import { initialState, loadState, saveState } from "../../src/core/state.js";
import { projectPaths } from "../../src/core/paths.js";
import { LrError } from "../../src/core/errors.js";

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
