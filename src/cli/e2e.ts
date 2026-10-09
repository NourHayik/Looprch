import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultE2e, e2eProblems, loadConfig, saveConfig, type Config, type E2eConfig } from "../core/config.js";
import { nowIso } from "../core/clock.js";
import { LrError, UsageError } from "../core/errors.js";
import { writeFileAtomic } from "../core/fsx.js";
import { appendEvent } from "../core/journal.js";
import { withLock } from "../core/lock.js";
import { oneOf } from "../core/validate.js";
import { loadState } from "../core/state.js";
import { e2eEnv, e2eSelected, e2eSetupProblems } from "../gates/e2e.js";
import { E2E_ENV_FILE, E2E_PROVIDER_IDS, E2E_PROVIDERS, E2E_RUNNER_PACKAGES, ensureGitignored, hasE2eTests, installCommand, missingEnvLines, providerEnvKeys, renderE2eConfig, renderEnvFile, smokeTest, type E2eInitOptions, type E2eProviderId } from "../gates/e2e-setup.js";
import { askConfirm, askSelect, askText, interactive } from "../ui/prompts.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = `looprch e2e <subcommand> [--root <dir>] [--json]
  init [--provider ${E2E_PROVIDER_IDS.join("|")}] [--model <id>]
       [--url <app url> | --start "<command>" [--ready-url <url>]] [--base-url <url>]
       [--phases all|P-001,P-002] [--install] [--force] [--enable] [--yes]
                                         set up e2e in one step: install the packages, write e2e.config.ts,
                                         a .env.e2e keys file and a first test, and save the gate
  status                                 show the optional TesterArmy e2e gate and check its setup
  configure [--config e2e.config.ts] [--bin node_modules/.bin/e2e] [--timeout 20m]
            [--arg=<e2e run selection arg>]... [--require-env NAME]... [--env NAME=value]...
            [--phases all|P-001,P-002] [--enable]
                                         check the setup (binary, config, keys, dry-run list) and save it
  enable                                 run the gate after the SEV3 gates pass (needs configure first)
  disable                                stop running the gate (the configuration is kept)
Without flags in a terminal, init asks for each choice. The gate runs
node_modules/.bin/e2e run --config <config> --reporter list,junit --output <fresh dir>.`;

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

/** The configure checks: Node version, setup files and keys, `e2e --version`, and a dry-run `e2e list` that selects at least one test. */
export function checkE2e(root: string, cfg: Config, e2e: E2eConfig): E2eCheck {
  const problems = e2eProblems({ ...e2e, enabled: false });
  if (!nodeSupported(process.versions.node)) problems.push(`Node ${process.versions.node} is not supported by e2e (needs ^22.22.3 or >=24.8.0)`);
  const setup = e2eSetupProblems(root, cfg, e2e);
  if (setup) problems.push(setup.reason);
  if (problems.length) return { ok: false, version: null, tests: 0, problems };
  const env = e2eEnv(root, cfg, e2e);
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

function phasesOpt(v: string | undefined, prev: E2eConfig["phases"]): E2eConfig["phases"] {
  if (v === undefined) return prev;
  return v === "all" ? "all" : v.split(",").map((x) => x.trim()).filter(Boolean);
}

interface InitFlags {
  provider?: string;
  model?: string;
  url?: string;
  start?: string;
  "ready-url"?: string;
  "base-url"?: string;
  phases?: string;
  install?: boolean;
  force?: boolean;
  enable?: boolean;
  yes?: boolean;
  json?: boolean;
}

/** The init choices: flags first; in a terminal, ask for what the flags leave open. */
async function initChoices(root: string, v: InitFlags): Promise<E2eInitOptions & { install: boolean }> {
  const ask = interactive() && !v.yes && !v.json;
  let provider = v.provider;
  if (!provider) {
    if (!ask) throw new UsageError(`Name the model provider: --provider ${E2E_PROVIDER_IDS.join("|")} (none: tests without agent steps)`, USAGE);
    provider = await askSelect("Which model should agent steps use?", E2E_PROVIDER_IDS.map((id) => ({ value: id, label: E2E_PROVIDERS[id].label })), "openrouter");
  }
  if (!oneOf(provider, E2E_PROVIDER_IDS)) throw new UsageError(`Unknown provider ${provider}; use one of ${E2E_PROVIDER_IDS.join(", ")}`, USAGE);
  const p = E2E_PROVIDERS[provider as E2eProviderId];
  let model = v.model ?? "";
  if (!model && p.model && ask) model = await askText(`Model id for ${p.label}`, p.defaultModel, p.defaultModel || "the model id your endpoint serves");
  if (!model) model = p.defaultModel;
  let baseUrl = v["base-url"] ?? null;
  if (!baseUrl && p.id === "openai-compatible" && ask) baseUrl = (await askText("Endpoint URL (ends with /v1)", "http://127.0.0.1:11434/v1")) || null;
  let url = v.url ?? "";
  let start = v.start ?? null;
  if (!url && !start && ask) {
    const how = await askSelect("How do the tests reach the app?", [
      { value: "start", label: "The runner starts it with a command (for example npm run dev)" },
      { value: "url", label: "It is already running at a URL" },
    ]);
    if (how === "start") start = (await askText("Start command", "npm run dev")) || null;
    url = await askText("App URL", "http://localhost:3000");
  }
  if (!url) url = "http://localhost:3000";
  let install = !!v.install;
  if (!install && ask && !existsSync(join(root, "node_modules", ".bin", "e2e"))) install = await askConfirm(`Install ${[...E2E_RUNNER_PACKAGES, ...p.packages].join(" ")} now?`, false, true);
  return { provider: p, model, url, start, readyUrl: v["ready-url"] ?? null, baseUrl, install };
}

/** `looprch e2e init`: everything a working gate needs, in one step; the user only fills in .env.e2e. */
async function init(root: string, v: InitFlags): Promise<number> {
  const json = !!v.json;
  const o = await initChoices(root, v);
  if (!nodeSupported(process.versions.node)) throw new LrError("e2e_node", `Node ${process.versions.node} is not supported by the e2e runner`, "Use Node 24.8+ (or 22.22.3+ on Node 22), then run looprch e2e init again");
  const installed: string[] = [];
  if (o.install) {
    const argv = installCommand(root, [...E2E_RUNNER_PACKAGES, ...o.provider.packages]);
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: root, stdio: json ? "pipe" : "inherit", encoding: "utf8" });
    if (r.status !== 0) throw new LrError("e2e_install_failed", `${argv.join(" ")} failed (exit ${r.status ?? r.error?.message})`, "Fix the install error, then run looprch e2e init again");
    installed.push(...argv.slice(3));
  }
  return withLock(root, null, "e2e init", () => {
    const files: Record<string, string> = {};
    const configPath = join(root, "e2e.config.ts");
    if (existsSync(configPath) && !v.force) files["e2e.config.ts"] = "kept (pass --force to replace it; a .bak is written)";
    else {
      if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.bak`);
      writeFileAtomic(configPath, renderE2eConfig(o));
      files["e2e.config.ts"] = "written";
    }
    const envPath = join(root, E2E_ENV_FILE);
    if (!existsSync(envPath)) {
      writeFileAtomic(envPath, renderEnvFile(o));
      files[E2E_ENV_FILE] = "written";
    } else {
      const add = missingEnvLines(readFileSync(envPath, "utf8"), o);
      if (add) writeFileAtomic(envPath, `${readFileSync(envPath, "utf8").trimEnd()}\n${add}`);
      files[E2E_ENV_FILE] = add ? "kept, missing keys added" : "kept";
    }
    if (ensureGitignored(root, E2E_ENV_FILE)) files[".gitignore"] = `${E2E_ENV_FILE} added`;
    if (!hasE2eTests(root)) {
      writeFileAtomic(join(root, "tests", "e2e", "smoke.e2e.ts"), smokeTest());
      files["tests/e2e/smoke.e2e.ts"] = "written";
    }
    const cfg = loadConfig(root);
    const prev = cfg.integrations.e2e ?? defaultE2e();
    const next: E2eConfig = { ...prev, config: "e2e.config.ts", required_env: providerEnvKeys(o.provider).filter((k) => k.required).map((k) => k.name), phases: phasesOpt(v.phases, prev.phases), configured_at: null, enabled: false };
    const check = checkE2e(root, cfg, next);
    if (check.ok) {
      next.configured_at = nowIso();
      next.enabled = !!v.enable;
    }
    cfg.integrations.e2e = next;
    saveConfig(root, cfg);
    appendEvent(root, { type: "config.changed", data: { key: "integrations.e2e", provider: o.provider.id, configured: check.ok, enabled: next.enabled } });
    const keys = providerEnvKeys(o.provider).filter((k) => k.required && !e2eEnv(root, cfg, next)[k.name]);
    const nextSteps = check.ok
      ? next.enabled
        ? ["The e2e gate is ready and enabled: it runs after the SEV3 gates pass."]
        : ["The e2e gate is ready. Turn it on with: looprch e2e enable"]
      : keys.length
        ? [`Open ${E2E_ENV_FILE} and fill in: ${keys.map((k) => `${k.name} (${k.what}; get it at ${k.where})`).join("; ")}.`, "Then run: looprch e2e configure --enable"]
        : [...check.problems.map((p) => `Fix: ${p}`), "Then run: looprch e2e configure --enable"];
    const r = { ok: check.ok, provider: o.provider.id, model: o.model || null, installed, files, required_env: next.required_env, missing_keys: keys.map((k) => k.name), check, configured: check.ok, enabled: next.enabled, next: nextSteps };
    out(json, r, () => [`E2E setup (${o.provider.label}):`, ...Object.entries(files).map(([f, s]) => `  ${f}: ${s}`), ...(installed.length ? [`  installed: ${installed.join(" ")}`] : []), "", ...nextSteps].join("\n"));
    return 0;
  });
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
      provider: { type: "string" },
      model: { type: "string" },
      url: { type: "string" },
      start: { type: "string" },
      "ready-url": { type: "string" },
      "base-url": { type: "string" },
      install: { type: "boolean" },
      force: { type: "boolean" },
      yes: { type: "boolean" },
    },
    USAGE,
  );
  const root = projectRoot(values.root);
  const json = !!values.json;
  switch (sub) {
    case "init":
      return init(root, values);
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
        env_file: existsSync(join(root, E2E_ENV_FILE)) ? E2E_ENV_FILE : null,
        runs_in_current_phase: st.current ? e2eSelected(e2e ?? undefined, st.current.phase) : null,
      };
      out(json, r, () =>
        !e2e
          ? "E2E testing is not configured (optional). Run /lr-e2e-test-init, or looprch e2e init, to set it up."
          : [`E2E testing: ${e2e.enabled ? "enabled" : "disabled"}, ${e2e.configured_at ? `configured ${e2e.configured_at}` : "not configured"}`, `Command: ${e2e.bin} run --config ${e2e.config} --reporter list,junit --output <fresh dir> ${e2e.args.join(" ")}`.trim(), `Timeout ${e2e.timeout}; phases ${e2e.phases === "all" ? "all" : e2e.phases.join(", ")}${e2e.required_env.length ? `; requires ${e2e.required_env.join(", ")} (in ${E2E_ENV_FILE} or the shell)` : ""}`, ...(setup ? [`Setup problem: ${setup.reason}`] : [])].join("\n"),
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
        const next: E2eConfig = {
          ...prev,
          config: values.config ?? prev.config,
          bin: values.bin ?? prev.bin,
          timeout: values.timeout ?? prev.timeout,
          args: values.arg !== undefined ? listOpt(values.arg) : prev.args,
          required_env: values["require-env"] !== undefined ? listOpt(values["require-env"]) : prev.required_env,
          env,
          phases: phasesOpt(values.phases, prev.phases),
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
          if (!e2e?.configured_at) throw new LrError("e2e_not_configured", "E2E testing is not configured yet", "Run /lr-e2e-test-init (or looprch e2e init, then looprch e2e configure) first");
          const setup = e2eSetupProblems(root, cfg, e2e);
          if (setup) throw new LrError("e2e_not_configured", `The E2E setup no longer works: ${setup.reason}`, "Fix it, then run looprch e2e configure --enable");
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
