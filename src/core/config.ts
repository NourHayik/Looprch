import { existsSync } from "node:fs";
import { CONFIG_SCHEMA, READ_ONLY_ROLES, ROLES, type Role } from "./constants.js";
import { LrError } from "./errors.js";
import { readJson, writeJsonAtomic } from "./fsx.js";
import { migrate, type Migration } from "./migrations.js";
import { projectPaths } from "./paths.js";
import { isDuration } from "./clock.js";
import { Issues, isInt, isNonEmptyString, isObject, oneOf } from "./validate.js";

export const AGENT_IDS = ["codex", "cursor", "agy", "kimi", "hermes", "opencode", "grok"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const MODES = ["direct", "delegate"] as const;
export type Mode = (typeof MODES)[number];
export const APPROVALS = ["never", "high-risk", "always"] as const;
export type Approval = (typeof APPROVALS)[number];

export interface Assignment {
  mode: Mode;
  agent: AgentId;
  model: string;
  effort?: string | null;
  timeout?: string;
  context_kb?: number | null;
}

export interface RoleConfig extends Assignment {
  fallbacks: Assignment[];
  max_parallel?: number;
}

export interface GatesAck {
  manifest_sha256: string;
  acknowledged_at: string;
  commands: { argv0: string; count: number }[];
}

export interface Config {
  schema_version: number;
  project: { id: string | null };
  lead_host: AgentId | null;
  agents: AgentId[];
  roles: Partial<Record<Role, RoleConfig>>;
  context_kb: Partial<Record<AgentId, number | null>>;
  limits: {
    repair_rounds: number;
    quota_wait_minutes: number;
    run_attempts: number;
    dispatch_max_wait: string;
    expansion_rounds: number;
    /** Reviews that may request changes in one phase; absent in older configs (default 3). */
    review_rounds?: number;
    /** Plan Debater passes on the initial plan (debate plus rebuttals); default 3. */
    debate_rounds?: number;
    /** Executability readbacks by the Implementer's model before plan approval; 0 disables; default 2. */
    readback_rounds?: number;
    /** Review reports of one finding lineage before Looprch asks the user instead of repairing again; default 2. */
    lineage_attempts?: number;
  };
  approvals: { plan: Approval; merge: Approval };
  git: { phase_branches: boolean };
  gates: { env: Record<string, string> };
  integrations: { commit_generated: boolean; e2e?: E2eConfig };
  spec: { gates_ack: GatesAck | null };
}

/** Optional TesterArmy `e2e` gate (https://tester.army/e2e), run by Looprch after the SEV3 gates pass. */
export interface E2eConfig {
  enabled: boolean;
  /** Set by `looprch e2e configure` after its checks passed; null means not configured. */
  configured_at: string | null;
  /** The e2e config file, relative to the project root. */
  config: string;
  /** The e2e executable, relative to the project root (never npx, which may download). */
  bin: string;
  /** Extra `e2e run` arguments (selection only: --target, --tag, --grep, files). Looprch adds --config, --reporter and --output. */
  args: string[];
  timeout: string;
  /** Environment for the run (in addition to gates.env). */
  env: Record<string, string>;
  /** Variables that must be set when the gate runs (for example a model key); values are never stored. */
  required_env: string[];
  /** Phases that run the gate. */
  phases: "all" | string[];
}

export function defaultE2e(): E2eConfig {
  return {
    enabled: false,
    configured_at: null,
    config: "e2e.config.ts",
    bin: "node_modules/.bin/e2e",
    args: [],
    timeout: "20m",
    env: { CI: "1", E2E_TELEMETRY_DISABLED: "1" },
    required_env: [],
    phases: "all",
  };
}

export const DEFAULT_DEBATE_ROUNDS = 3;
export const DEFAULT_READBACK_ROUNDS = 2;
export const DEFAULT_LINEAGE_ATTEMPTS = 2;

export function debateRounds(cfg: Config): number {
  return cfg.limits.debate_rounds ?? DEFAULT_DEBATE_ROUNDS;
}

export function readbackRounds(cfg: Config): number {
  return cfg.limits.readback_rounds ?? DEFAULT_READBACK_ROUNDS;
}

export function lineageAttempts(cfg: Config): number {
  return cfg.limits.lineage_attempts ?? DEFAULT_LINEAGE_ATTEMPTS;
}

export const DEFAULT_TIMEOUTS: Record<Role, string> = {
  planner: "60m",
  plan_debater: "60m",
  implementer: "2h",
  tester: "60m",
  reviewer: "60m",
  worker: "30m",
};

export const DEFAULT_REVIEW_ROUNDS = 3;

export function reviewRounds(cfg: Config): number {
  return cfg.limits.review_rounds ?? DEFAULT_REVIEW_ROUNDS;
}

export function defaultConfig(): Config {
  return {
    schema_version: CONFIG_SCHEMA,
    project: { id: null },
    lead_host: null,
    agents: [],
    roles: {},
    context_kb: {},
    limits: {
      repair_rounds: 3,
      quota_wait_minutes: 60,
      run_attempts: 2,
      dispatch_max_wait: "10m",
      expansion_rounds: 2,
      review_rounds: DEFAULT_REVIEW_ROUNDS,
      debate_rounds: DEFAULT_DEBATE_ROUNDS,
      readback_rounds: DEFAULT_READBACK_ROUNDS,
      lineage_attempts: DEFAULT_LINEAGE_ATTEMPTS,
    },
    approvals: { plan: "never", merge: "never" },
    git: { phase_branches: true },
    gates: { env: {} },
    integrations: { commit_generated: false },
    spec: { gates_ack: null },
  };
}

/** What config validation needs to know about each agent; supplied by the agents registry. */
export interface AgentCaps {
  direct: boolean;
  delegate: boolean;
  readOnly: "enforced" | "best-effort" | "none";
  modelFormat?: "provider/model";
}

export interface ValidationContext {
  caps: Record<AgentId, AgentCaps>;
  relayExists?: (agent: AgentId) => boolean;
  knownModels?: (agent: AgentId) => string[] | null;
  requirePrimaryRoles?: boolean;
}

export const CONFIG_MIGRATIONS: Migration[] = [];

function checkAssignment(issues: Issues, where: string, a: unknown, cfg: Config, ctx: ValidationContext, role: Role, isFallback: boolean): void {
  if (!isObject(a)) {
    issues.error(`${where}: must be an object`);
    return;
  }
  if (!oneOf(a.mode, MODES)) issues.error(`${where}.mode must be "direct" or "delegate"`);
  if (!oneOf(a.agent, AGENT_IDS)) {
    issues.error(`${where}.agent must be one of ${AGENT_IDS.join(", ")}`);
    return;
  }
  const agent = a.agent as AgentId;
  if (!cfg.agents.includes(agent)) issues.error(`${where}.agent "${agent}" is not enabled in this project (run: looprch add . --agents ${agent})`);
  if (!isNonEmptyString(a.model)) issues.error(`${where}.model is required (Looprch never invents model ids)`);
  if (a.effort !== undefined && a.effort !== null && !isNonEmptyString(a.effort)) issues.error(`${where}.effort must be a string or null`);
  if (a.timeout !== undefined && !isDuration(a.timeout)) issues.error(`${where}.timeout must look like 30m, 2h or 45s`);
  if (a.context_kb !== undefined && a.context_kb !== null && !isInt(a.context_kb, 1)) issues.error(`${where}.context_kb must be a positive integer or null`);
  const caps = ctx.caps[agent];
  if (a.mode === "direct") {
    if (!caps.direct) issues.error(`${where}: ${agent} has no verified Direct subagent support; use mode "delegate" with another agent`);
    if (!isFallback && cfg.lead_host && agent !== cfg.lead_host)
      issues.warn(`${where}: Direct role on ${agent} while lead_host is ${cfg.lead_host}; it will run through ${agent}-delegate when the Lead is elsewhere (D-05)`);
  }
  if (a.mode === "delegate" || (a.mode === "direct" && cfg.lead_host && agent !== cfg.lead_host)) {
    if (!caps.delegate) issues.error(`${where}: ${agent} has no delegate relay; it can only be used as the Lead host`);
    else if (ctx.relayExists && !ctx.relayExists(agent)) issues.error(`${where}: relay ${agent}-delegate is not installed (run: looprch install-relay ${agent})`);
  }
  if (READ_ONLY_ROLES.includes(role) && a.mode === "delegate" && caps.readOnly === "none")
    issues.warn(`${where}: ${agent}-delegate cannot enforce read-only; Looprch still checks git status before and after`);
  if (caps.modelFormat === "provider/model" && isNonEmptyString(a.model) && !/^[^/]+\/.+/.test(a.model))
    issues.error(`${where}.model must be "provider/model" for ${agent}`);
  if (ctx.knownModels && isNonEmptyString(a.model)) {
    const known = ctx.knownModels(agent);
    if (known && known.length && !known.includes(a.model)) issues.warn(`${where}.model "${a.model}" is not in the models discovered for ${agent}`);
  }
}

export function validateConfig(raw: unknown, ctx: ValidationContext): Issues {
  const issues = new Issues();
  if (!isObject(raw)) {
    issues.error("config must be a JSON object");
    return issues;
  }
  const cfg = raw as unknown as Config;
  if (cfg.schema_version !== CONFIG_SCHEMA) issues.error(`schema_version must be ${CONFIG_SCHEMA}`);
  if (!Array.isArray(cfg.agents) || !cfg.agents.every((a) => oneOf(a, AGENT_IDS))) issues.error(`agents must be a list of ${AGENT_IDS.join(", ")}`);
  else if (new Set(cfg.agents).size !== cfg.agents.length) issues.error("agents contains duplicates");
  if (cfg.lead_host !== null && !oneOf(cfg.lead_host, AGENT_IDS)) issues.error("lead_host must be an agent id or null");
  else if (cfg.lead_host && Array.isArray(cfg.agents) && !cfg.agents.includes(cfg.lead_host)) issues.error(`lead_host "${cfg.lead_host}" is not enabled`);
  if (!isObject(cfg.roles)) issues.error("roles must be an object");
  else {
    for (const key of Object.keys(cfg.roles)) {
      if (!oneOf(key, ROLES)) {
        issues.error(`roles.${key}: unknown role (valid: ${ROLES.join(", ")})`);
        continue;
      }
      const rc = cfg.roles[key as Role] as unknown;
      if (Array.isArray(cfg.agents)) checkAssignment(issues, `roles.${key}`, rc, cfg, ctx, key as Role, false);
      if (isObject(rc)) {
        if (!Array.isArray(rc.fallbacks)) issues.error(`roles.${key}.fallbacks must be a list`);
        else rc.fallbacks.forEach((f, i) => checkAssignment(issues, `roles.${key}.fallbacks[${i}]`, f, cfg, ctx, key as Role, true));
        if (key === "worker" && rc.max_parallel !== undefined && !isInt(rc.max_parallel, 1, 8)) issues.error("roles.worker.max_parallel must be 1..8");
      }
    }
    if (ctx.requirePrimaryRoles) {
      for (const r of ["planner", "plan_debater", "implementer", "tester", "reviewer"] as Role[])
        if (!cfg.roles[r]) issues.error(`roles.${r} is not configured (run /lr-init or looprch config set-role ${r} ...)`);
    }
  }
  if (!isObject(cfg.context_kb)) issues.error("context_kb must be an object");
  else
    for (const [k, v] of Object.entries(cfg.context_kb)) {
      if (!oneOf(k, AGENT_IDS)) issues.error(`context_kb.${k}: unknown agent`);
      if (v !== null && !isInt(v, 1)) issues.error(`context_kb.${k} must be a positive integer or null`);
    }
  const l = cfg.limits as unknown;
  if (!isObject(l)) issues.error("limits must be an object");
  else {
    if (!isInt(l.repair_rounds, 1, 10)) issues.error("limits.repair_rounds must be 1..10");
    if (!isInt(l.quota_wait_minutes, 0, 1440)) issues.error("limits.quota_wait_minutes must be 0..1440");
    if (!isInt(l.run_attempts, 1, 5)) issues.error("limits.run_attempts must be 1..5");
    if (!isDuration(l.dispatch_max_wait)) issues.error("limits.dispatch_max_wait must be a duration like 10m");
    if (!isInt(l.expansion_rounds, 0, 5)) issues.error("limits.expansion_rounds must be 0..5");
    if (l.review_rounds !== undefined && !isInt(l.review_rounds, 1, 10)) issues.error("limits.review_rounds must be 1..10");
    if (l.debate_rounds !== undefined && !isInt(l.debate_rounds, 1, 5)) issues.error("limits.debate_rounds must be 1..5");
    if (l.readback_rounds !== undefined && !isInt(l.readback_rounds, 0, 3)) issues.error("limits.readback_rounds must be 0..3");
    if (l.lineage_attempts !== undefined && !isInt(l.lineage_attempts, 1, 5)) issues.error("limits.lineage_attempts must be 1..5");
  }
  if (!isObject(cfg.approvals) || !oneOf(cfg.approvals.plan, APPROVALS) || !oneOf(cfg.approvals.merge, APPROVALS))
    issues.error(`approvals.plan and approvals.merge must be one of ${APPROVALS.join(", ")}`);
  if (!isObject(cfg.git) || typeof cfg.git.phase_branches !== "boolean") issues.error("git.phase_branches must be true or false");
  if (!isObject(cfg.gates) || !isObject(cfg.gates.env)) issues.error("gates.env must be an object");
  else
    for (const [k, v] of Object.entries(cfg.gates.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) issues.error(`gates.env.${k}: names must match ^[A-Z_][A-Z0-9_]*$`);
      if (typeof v !== "string") issues.error(`gates.env.${k} must be a string`);
    }
  if (!isObject(cfg.integrations) || typeof cfg.integrations.commit_generated !== "boolean") issues.error("integrations.commit_generated must be true or false");
  else if (cfg.integrations.e2e !== undefined) for (const p of e2eProblems(cfg.integrations.e2e)) issues.error(`integrations.e2e: ${p}`);
  if (!isObject(cfg.spec)) issues.error("spec must be an object");
  return issues;
}

/** Shape problems of integrations.e2e. Whether the setup actually works is `looprch e2e configure`'s job. */
export function e2eProblems(raw: unknown): string[] {
  if (!isObject(raw)) return ["must be an object"];
  const p: string[] = [];
  if (typeof raw.enabled !== "boolean") p.push("enabled must be true or false");
  if (raw.configured_at !== null && !isNonEmptyString(raw.configured_at)) p.push("configured_at must be a timestamp or null");
  for (const k of ["config", "bin"]) {
    const v = raw[k];
    if (!isNonEmptyString(v)) p.push(`${k} is required`);
    else if (v.startsWith("/") || v.split("/").includes("..")) p.push(`${k} must be a path inside the project`);
  }
  if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string")) p.push("args must be a list of strings");
  else if (raw.args.some((a) => /^--(config|reporter|output)(=|$)/.test(a))) p.push("args must not set --config, --reporter or --output (Looprch sets them)");
  if (!isDuration(raw.timeout)) p.push("timeout must look like 20m");
  if (!isObject(raw.env) || !Object.entries(raw.env).every(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === "string")) p.push("env must map NAMES to strings");
  if (!Array.isArray(raw.required_env) || !raw.required_env.every((k) => typeof k === "string" && /^[A-Z_][A-Z0-9_]*$/.test(k))) p.push("required_env must be a list of variable names");
  if (raw.phases !== "all" && !(Array.isArray(raw.phases) && raw.phases.every((x) => typeof x === "string" && /^P-\d{3,}$/.test(x)))) p.push('phases must be "all" or a list of phase ids');
  if (raw.enabled === true && raw.configured_at === null) p.push("enabled before it was configured: run /lr-e2e-test-init (looprch e2e configure)");
  return p;
}

export function configExists(root: string): boolean {
  return existsSync(projectPaths(root).config);
}

export function loadConfig(root: string): Config {
  const paths = projectPaths(root);
  if (!existsSync(paths.config)) throw new LrError("not_attached", `No .looprch/config.json in ${root}`, "Run: looprch add .");
  const raw = readJson<Record<string, unknown>>(paths.config);
  const migrated = migrate(raw, "config", CONFIG_SCHEMA, CONFIG_MIGRATIONS, paths.backups, paths.config);
  const base = defaultConfig();
  const cfg = migrated as unknown as Config;
  return {
    ...base,
    ...cfg,
    limits: { ...base.limits, ...(cfg.limits ?? {}) },
    approvals: { ...base.approvals, ...(cfg.approvals ?? {}) },
    git: { ...base.git, ...(cfg.git ?? {}) },
    gates: { env: { ...(cfg.gates?.env ?? {}) } },
    integrations: { ...base.integrations, ...(cfg.integrations ?? {}) },
    spec: { ...base.spec, ...(cfg.spec ?? {}) },
    context_kb: { ...(cfg.context_kb ?? {}) },
    roles: { ...(cfg.roles ?? {}) },
  };
}

export function saveConfig(root: string, cfg: Config): void {
  writeJsonAtomic(projectPaths(root).config, cfg);
}
