import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultE2e, e2eProblems, loadConfig, saveConfig, type Config, type E2eConfig } from "../core/config.js";
import { nowIso } from "../core/clock.js";
import { LrError, UsageError } from "../core/errors.js";
import { appendEvent } from "../core/journal.js";
import { withLock } from "../core/lock.js";
import { loadState } from "../core/state.js";
import { e2eSelected, e2eSetupProblems } from "../gates/e2e.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = `looprch e2e <subcommand> [--root <dir>] [--json]
  status                                 show the optional TesterArmy e2e gate and check its setup
  configure [--config e2e.config.ts] [--bin node_modules/.bin/e2e] [--timeout 20m]
            [--arg=<e2e run selection arg>]... [--require-env NAME]... [--env NAME=value]...
            [--phases all|P-001,P-002] [--enable]
                                         check the setup (binary, config, dry-run list) and save it
  enable                                 run the gate after the SEV3 gates pass (needs configure first)
  disable                                stop running the gate (the configuration is kept)
The gate runs node_modules/.bin/e2e run --config <config> --reporter list,junit --output <fresh dir>.
Configure it interactively with /lr-e2e-test-init.`;

/** e2e 0.18 engines: ^22.22.3 || >=24.8.0. */
export function nodeSupported(version: string): boolean {
  const [maj, min, pat] = version.replace(/^v/, "").split(".").map((x) => Number(x));
  if (maj === 22) return (min ?? 0) > 22 || ((min ?? 0) === 22 && (pat ?? 0) >= 3);
  if (maj === 24) return (min ?? 0) >= 8;
  return (maj ?? 0) > 24;
}

export interface E2eCheck {
  ok: boolean;
  version: string | null;
  tests: number;
  problems: string[];
}

/** The configure checks: Node version, setup files, `e2e --version`, and a dry-run `e2e list` that selects at least one test. */
export function checkE2e(root: string, cfg: Config, e2e: E2eConfig): E2eCheck {
  const problems = e2eProblems({ ...e2e, enabled: false });
  if (!nodeSupported(process.versions.node)) problems.push(`Node ${process.versions.node} is not supported by e2e (needs ^22.22.3 or >=24.8.0)`);
  const setup = e2eSetupProblems(root, cfg, e2e);
  if (setup) problems.push(setup.reason);
  if (problems.length) return { ok: false, version: null, tests: 0, problems };
  const env = { ...process.env, ...cfg.gates.env, ...e2e.env };
  const bin = join(root, e2e.bin);
  const v = spawnSync(bin, ["--version"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  const version = v.status === 0 ? v.stdout.trim() : null;
  if (!version) return { ok: false, version: null, tests: 0, problems: [`${e2e.bin} --version failed: ${(v.stderr || v.stdout || v.error?.message || "").trim().slice(0, 300)}`] };
  const l = spawnSync(bin, ["list", "--config", e2e.config, "--reporter", "json", ...e2e.args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  if (l.status !== 0) return { ok: false, version, tests: 0, problems: [`e2e list exited ${l.status ?? l.signal}: ${(l.stderr || l.stdout).trim().split("\n").slice(-5).join(" ").slice(0, 400)}`] };
  let tests = 0;
  try {
    const pairs = (JSON.parse(l.stdout) as { pairs?: { disposition?: string }[] }).pairs ?? [];
    tests = pairs.filter((p) => p.disposition !== "skip").length;
  } catch {
    return { ok: false, version, tests: 0, problems: ["e2e list --reporter json did not print a JSON report"] };
  }
  if (!tests) return { ok: false, version, tests, problems: ["e2e list selects no test: write at least one *.e2e.ts test (or fix the selection arguments)"] };
  return { ok: true, version, tests, problems: [] };
}

function listOpt(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)];
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return sub ? 0 : 2;
  }
  const { values } = parse(
    rest,
    {
      root: { type: "string" },
      config: { type: "string" },
      bin: { type: "string" },
      timeout: { type: "string" },
      arg: { type: "string", multiple: true },
      "require-env": { type: "string", multiple: true },
      env: { type: "string", multiple: true },
      phases: { type: "string" },
      enable: { type: "boolean" },
    },
    USAGE,
  );
  const root = projectRoot(values.root);
  const json = !!values.json;
  switch (sub) {
    case "status": {
      const cfg = loadConfig(root);
      const e2e = cfg.integrations.e2e ?? null;
      const st = loadState(root);
      const setup = e2e ? e2eSetupProblems(root, cfg, e2e) : null;
      const r = {
        configured: !!e2e?.configured_at,
        enabled: !!e2e?.enabled,
        config: e2e,
        setup_problem: setup?.reason ?? null,
        runs_in_current_phase: st.current ? e2eSelected(e2e ?? undefined, st.current.phase) : null,
      };
      out(json, r, () =>
        !e2e
          ? "E2E testing is not configured (optional). Run /lr-e2e-test-init to set it up."
          : [`E2E testing: ${e2e.enabled ? "enabled" : "disabled"}, ${e2e.configured_at ? `configured ${e2e.configured_at}` : "not configured"}`, `Command: ${e2e.bin} run --config ${e2e.config} --reporter list,junit --output <fresh dir> ${e2e.args.join(" ")}`.trim(), `Timeout ${e2e.timeout}; phases ${e2e.phases === "all" ? "all" : e2e.phases.join(", ")}${e2e.required_env.length ? `; requires ${e2e.required_env.join(", ")}` : ""}`, ...(setup ? [`Setup problem: ${setup.reason}`] : [])].join("\n"),
      );
      return 0;
    }
    case "configure":
      return withLock(root, null, "e2e configure", () => {
        const cfg = loadConfig(root);
        const prev = cfg.integrations.e2e ?? defaultE2e();
        const env = { ...prev.env };
        for (const kv of listOpt(values.env)) {
          const i = kv.indexOf("=");
          if (i < 1) throw new UsageError(`--env needs NAME=value (got ${kv})`, USAGE);
          env[kv.slice(0, i)] = kv.slice(i + 1);
        }
        const phases = values.phases === undefined ? prev.phases : values.phases === "all" ? "all" : values.phases.split(",").map((x) => x.trim()).filter(Boolean);
        const next: E2eConfig = {
          ...prev,
          config: values.config ?? prev.config,
          bin: values.bin ?? prev.bin,
          timeout: values.timeout ?? prev.timeout,
          args: values.arg !== undefined ? listOpt(values.arg) : prev.args,
          required_env: values["require-env"] !== undefined ? listOpt(values["require-env"]) : prev.required_env,
          env,
          phases,
          configured_at: null,
          enabled: false,
        };
        const check = checkE2e(root, cfg, next);
        if (!check.ok) {
          out(json, { ok: false, problems: check.problems, config: next }, () => ["E2E setup is not ready; nothing was saved:", ...check.problems.map((p) => `  - ${p}`)].join("\n"));
          return 1;
        }
        next.configured_at = nowIso();
        next.enabled = values.enable ? true : prev.configured_at !== null && prev.enabled;
        cfg.integrations.e2e = next;
        saveConfig(root, cfg);
        appendEvent(root, { type: "config.changed", data: { key: "integrations.e2e", configured: true, enabled: next.enabled, tests: check.tests, version: check.version } });
        out(json, { ok: true, version: check.version, tests: check.tests, config: next }, () => `E2E configured: e2e ${check.version}, ${check.tests} test(s) selected; the gate is ${next.enabled ? "enabled" : "disabled (run looprch e2e enable)"}.`);
        return 0;
      });
    case "enable":
    case "disable":
      return withLock(root, null, `e2e ${sub}`, () => {
        const cfg = loadConfig(root);
        const e2e = cfg.integrations.e2e;
        if (sub === "enable") {
          if (!e2e?.configured_at) throw new LrError("e2e_not_configured", "E2E testing is not configured yet", "Run /lr-e2e-test-init (or looprch e2e configure) first");
          const setup = e2eSetupProblems(root, cfg, e2e);
          if (setup) throw new LrError("e2e_not_configured", `The E2E setup no longer works: ${setup.reason}`, "Run /lr-e2e-test-init (or looprch e2e configure) again");
          e2e.enabled = true;
        } else if (e2e) e2e.enabled = false;
        else {
          out(json, { enabled: false }, "E2E testing is not configured; nothing to disable.");
          return 0;
        }
        saveConfig(root, cfg);
        appendEvent(root, { type: "config.changed", data: { key: "integrations.e2e.enabled", value: e2e.enabled } });
        out(json, { enabled: e2e.enabled }, `E2E gate ${e2e.enabled ? "enabled: it runs after the SEV3 gates pass" : "disabled"}.`);
        return 0;
      });
    default:
      throw new UsageError(`Unknown subcommand ${sub}`, USAGE);
  }
}

export function e2eDoctorSummary(root: string, cfg: Config): { status: "ok" | "warn" | "fail" | "skip"; summary: string; fix?: string } {
  const e2e = cfg.integrations.e2e;
  if (!e2e) return { status: "skip", summary: "E2E testing not configured (optional)" };
  if (!e2e.enabled) return { status: "ok", summary: `E2E gate disabled${e2e.configured_at ? " (configured)" : ""}` };
  const setup = e2eSetupProblems(root, cfg, e2e);
  if (setup) return { status: "fail", summary: `E2E gate enabled but not runnable: ${setup.reason}`, fix: "Run /lr-e2e-test-init, or looprch e2e disable" };
  return existsSync(join(root, e2e.config)) ? { status: "ok", summary: `E2E gate enabled (${e2e.config})` } : { status: "fail", summary: `${e2e.config} missing`, fix: "Run /lr-e2e-test-init" };
}
