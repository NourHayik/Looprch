import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, REPO, copyFixture, initRepo, runCli, sandbox, type Sandbox } from "./tmp.js";
import { installFakes } from "./fakes.js";

export interface DriveOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  host?: string;
  scope?: "phase" | "auto" | "finish";
  answers?: Record<string, string>;
  maxSteps?: number;
  dispatchWait?: string;
  stopOn?: string[];
  onAction?: (a: any) => "stop" | void;
}

export interface DriveResult {
  actions: any[];
  last: any;
}

function cli(args: string[], o: DriveOptions, input?: string) {
  const r = runCli([...args, "--json"], { cwd: o.root, env: o.env, input });
  if (r.json === null) throw new Error(`looprch ${args.join(" ")} printed no JSON (exit ${r.code}): ${r.stdout}\n${r.stderr}`);
  return r.json;
}

/** Run a Direct role the way a host subagent would: the fake relay script, then `looprch record`. */
export function runDirect(a: any, o: DriveOptions): any {
  const out = mkdtempSync(join(tmpdir(), "lr-direct-"));
  const args = [join(FIXTURES, "fake-relay", "relay.mjs"), "--brief", join(o.root, a.brief), "--cd", o.root, "--out-dir", out];
  if (a.session?.id) args.push("--session", a.session.id);
  spawnSync(process.execPath, args, { env: { ...process.env, ...o.env, FAKE_AGENT: a.agent }, encoding: "utf8" });
  const res = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  const session = res.sessionId ?? res.threadId ?? res.conversationId;
  return cli(["record", a.run_id, "--stdin", ...(session ? ["--session", session] : [])], o, res.finalMessage);
}

export function drive(o: DriveOptions): DriveResult {
  const host = o.host ?? "cursor";
  const scope = o.scope ?? "phase";
  const actions: any[] = [];
  const stopOn = o.stopOn ?? ["paused", "blocked", "stop_before_closure", "project_done"];
  for (let i = 0; i < (o.maxSteps ?? 200); i++) {
    const a = cli(["next", "--host", host, "--scope", scope], o);
    actions.push(a);
    if (o.onAction?.(a) === "stop") return { actions, last: a };
    switch (a.action) {
      case "run_role":
        if (a.mode === "delegate") cli(["dispatch", a.run_id, "--max-wait", o.dispatchWait ?? "60s"], o);
        else runDirect(a, o);
        break;
      case "await_run":
        cli(["dispatch", "--wait", a.run_id, "--max-wait", o.dispatchWait ?? "60s"], o);
        break;
      case "run_gates":
      case "checkpoint":
        cli(a.command.slice(1), o);
        break;
      case "wait":
        cli(["wait", "--max", "20s"], o);
        break;
      case "ask_user": {
        const opt = o.answers?.[a.kind] ?? o.answers?.[a.question_id] ?? a.options[0].id;
        cli(["answer", a.question_id, opt], o);
        break;
      }
      case "phase_closed":
        if (scope === "phase" || stopOn.includes("phase_closed")) return { actions, last: a };
        break;
      default:
        if (stopOn.includes(a.action)) return { actions, last: a };
    }
  }
  throw new Error(`driver did not finish: last actions ${JSON.stringify(actions.slice(-3), null, 1)}`);
}

export interface Project {
  s: Sandbox;
  root: string;
  scenario: string;
  env: NodeJS.ProcessEnv;
  setScenario(rules: object[]): void;
  quota(json: string | null): void;
}

export interface ProjectRoles {
  [role: string]: { mode: "direct" | "delegate"; agent: string; model: string; fallbacks?: { mode: string; agent: string; model: string }[] };
}

export const DEFAULT_ROLES: ProjectRoles = {
  planner: { mode: "direct", agent: "cursor", model: "cursor-plan" },
  plan_debater: { mode: "delegate", agent: "kimi", model: "kimi-k" },
  implementer: { mode: "delegate", agent: "opencode", model: "oc/impl", fallbacks: [{ mode: "delegate", agent: "codex", model: "codex-impl" }] },
  tester: { mode: "delegate", agent: "codex", model: "codex-test" },
  reviewer: { mode: "direct", agent: "cursor", model: "cursor-review" },
  worker: { mode: "delegate", agent: "codex", model: "codex-worker" },
};

/** Installed core, fake relays/CLIs, notes-spec fixture in a fresh repo, roles configured, gates acknowledged. */
export function setupProject(opts: { roles?: ProjectRoles; config?: Record<string, string>; agents?: string } = {}): Project {
  const scenario = join(mkdtempSync(join(tmpdir(), "lr-scn-")), "scenario.json");
  writeFileSync(scenario, JSON.stringify({ rules: [] }));
  const quotaFile = join(mkdtempSync(join(tmpdir(), "lr-quota-")), "quota.json");
  const s = sandbox({ LOOPRCH_FAKE_SCENARIO: scenario, FAKE_IMPL_DIR: join(FIXTURES, "notes-impl"), FAKE_QUOTA_FILE: quotaFile });
  installFakes(s);
  const ok = (r: { code: number; stdout: string; stderr: string }, what: string) => {
    if (r.code !== 0) throw new Error(`${what} failed: ${r.stdout}\n${r.stderr}`);
  };
  ok(runCli(["install", "--from", REPO], { env: s.env }), "install");
  const root = join(s.dir, "proj");
  initRepo(root);
  copyFixture("notes-spec", root);
  ok(runCli(["add", root, "--agents", opts.agents ?? "cursor,codex,opencode,kimi", "--yes"], { env: s.env }), "add");
  const env = s.env;
  ok(runCli(["config", "set", "lead_host", "cursor"], { cwd: root, env }), "lead_host");
  for (const [role, rc] of Object.entries(opts.roles ?? DEFAULT_ROLES)) {
    ok(runCli(["config", "set-role", role, "--mode", rc.mode, "--agent", rc.agent, "--model", rc.model], { cwd: root, env }), `set-role ${role}`);
    for (const f of rc.fallbacks ?? []) ok(runCli(["config", "add-fallback", role, "--mode", f.mode, "--agent", f.agent, "--model", f.model], { cwd: root, env }), `fallback ${role}`);
  }
  for (const [k, v] of Object.entries(opts.config ?? {})) ok(runCli(["config", "set", k, v], { cwd: root, env }), `config ${k}`);
  const d = runCli(["init", "discover", "--json"], { cwd: root, env });
  ok(d, "discover");
  ok(runCli(["init", "ack-gates", "--manifest-sha256", d.json.manifest_sha256], { cwd: root, env }), "ack");
  return {
    s,
    root,
    scenario,
    env,
    setScenario: (rules) => writeFileSync(scenario, JSON.stringify({ rules })),
    quota: (json) => {
      if (json === null) writeFileSync(quotaFile, "");
      else writeFileSync(quotaFile, json);
      spawnSync("rm", ["-f", join(s.lrHome, "cache", "quota.json")]);
    },
  };
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}
