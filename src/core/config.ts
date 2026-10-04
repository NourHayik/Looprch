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
  };
  approvals: { plan: Approval; merge: Approval };
  git: { phase_branches: boolean };
  gates: { env: Record<string, string> };
  integrations: { commit_generated: boolean };
  spec: { gates_ack: GatesAck | null };
}

export const DEFAULT_TIMEOUTS: Record<Role, string> = {
  planner: "60m",
  plan_debater: "60m",
  implementer: "2h",
  tester: "60m",
  reviewer: "60m",
  worker: "30m",
};

export function defaultConfig(): Config {
  return {
    schema_version: CONFIG_SCHEMA,
    project: { id: null },
    lead_host: null,
    agents: [],
    roles: {},
    context_kb: {},
    limits: { repair_rounds: 3, quota_wait_minutes: 60, run_attempts: 2, dispatch_max_wait: "10m", expansion_rounds: 2 },
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
  if (!isObject(cfg.spec)) issues.error("spec must be an object");
  return issues;
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
