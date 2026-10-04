import { AGENT_IDS, APPROVALS, type AgentId, type Assignment, type Config, DEFAULT_TIMEOUTS, MODES, type Mode, loadConfig, saveConfig, validateConfig, type ValidationContext } from "../core/config.js";
import { ROLES, type Role } from "../core/constants.js";
import { LrError, UsageError } from "../core/errors.js";
import { appendEvent } from "../core/journal.js";
import { withLock } from "../core/lock.js";
import { isDuration } from "../core/clock.js";
import { agentCaps } from "../agents/index.js";
import { cachedModels } from "../delegate/discover.js";
import { locateRelay } from "../delegate/locate.js";
import { emptyReport } from "../install/links.js";
import { syncAgentFiles } from "../install/project-files.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = `looprch config <subcommand> [--root <dir>] [--json]
  show                                   print the project config
  validate                               validate roles, agents, relays and limits
  set-role <role> --mode direct|delegate --agent <id> --model <m> [--effort <e>] [--timeout <dur>] [--context-kb <n>] [--max-parallel <n>]
  add-fallback <role> --mode <m> --agent <id> --model <m> [--effort <e>] [--timeout <dur>] [--context-kb <n>]
  clear-fallbacks <role>
  set <key> <value>                      keys: lead_host, limits.*, approvals.plan|merge, git.phase_branches,
                                         gates.env.<NAME>, context_kb.<agent>, integrations.commit_generated
roles: ${ROLES.join(", ")}`;

export function validationContext(root: string, requirePrimaryRoles = false): ValidationContext {
  return { caps: agentCaps(), relayExists: (a) => !!locateRelay(root, a), knownModels: (a) => cachedModels(a), requirePrimaryRoles };
}

function roleArg(v: string | undefined): Role {
  if (!v || !(ROLES as readonly string[]).includes(v)) throw new UsageError(`Unknown role ${JSON.stringify(v)} (valid: ${ROLES.join(", ")})`, USAGE);
  return v as Role;
}

function assignmentFrom(values: Record<string, unknown>, role: Role, needTimeoutDefault: boolean): Assignment {
  const mode = values.mode as string | undefined;
  const agent = values.agent as string | undefined;
  const model = values.model as string | undefined;
  if (!mode || !(MODES as readonly string[]).includes(mode)) throw new UsageError("--mode direct|delegate is required", USAGE);
  if (!agent || !(AGENT_IDS as readonly string[]).includes(agent)) throw new UsageError(`--agent must be one of ${AGENT_IDS.join(", ")}`, USAGE);
  if (!model) throw new UsageError("--model is required (use a model from: looprch models <agent>)", USAGE);
  const a: Assignment = { mode: mode as Mode, agent: agent as AgentId, model };
  if (values.effort !== undefined) a.effort = String(values.effort);
  if (values.timeout !== undefined) {
    if (!isDuration(values.timeout)) throw new UsageError("--timeout must look like 30m or 2h", USAGE);
    a.timeout = String(values.timeout);
  } else if (needTimeoutDefault) a.timeout = DEFAULT_TIMEOUTS[role];
  if (values["context-kb"] !== undefined) a.context_kb = Number(values["context-kb"]);
  return a;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function setKey(cfg: Config, key: string, raw: string): void {
  const value = parseValue(raw);
  const parts = key.split(".");
  if (key === "lead_host") {
    if (value !== null && !(AGENT_IDS as readonly string[]).includes(String(value))) throw new UsageError(`lead_host must be one of ${AGENT_IDS.join(", ")} or null`);
    cfg.lead_host = value === null ? null : (String(value) as AgentId);
  } else if (parts[0] === "limits" && parts.length === 2 && parts[1]! in cfg.limits) {
    (cfg.limits as unknown as Record<string, unknown>)[parts[1]!] = value;
  } else if (parts[0] === "approvals" && (parts[1] === "plan" || parts[1] === "merge") && parts.length === 2) {
    if (!(APPROVALS as readonly string[]).includes(String(value))) throw new UsageError(`approvals.${parts[1]} must be one of ${APPROVALS.join(", ")}`);
    cfg.approvals[parts[1]] = String(value) as Config["approvals"]["plan"];
  } else if (key === "git.phase_branches") cfg.git.phase_branches = value === true;
  else if (parts[0] === "gates" && parts[1] === "env" && parts.length === 3) {
    if (value === null) delete cfg.gates.env[parts[2]!];
    else cfg.gates.env[parts[2]!] = String(raw);
  } else if (parts[0] === "context_kb" && parts.length === 2) cfg.context_kb[parts[1] as AgentId] = value as number | null;
  else if (key === "integrations.commit_generated") cfg.integrations.commit_generated = value === true;
  else throw new UsageError(`Unsupported config key "${key}"`, USAGE);
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return sub ? 0 : 2;
  }
  const opts = {
    root: { type: "string" },
    mode: { type: "string" },
    agent: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    timeout: { type: "string" },
    "context-kb": { type: "string" },
    "max-parallel": { type: "string" },
  } as const;
  const { values, positionals } = parse(rest, opts, USAGE);
  const root = projectRoot(values.root);
  const json = !!values.json;

  if (sub === "show") {
    const cfg = loadConfig(root);
    out(json, cfg, JSON.stringify(cfg, null, 2));
    return 0;
  }
  if (sub === "validate") {
    const cfg = loadConfig(root);
    const r = validateConfig(cfg, validationContext(root, true));
    out(json, { ok: r.ok, errors: r.errors, warnings: r.warnings }, () => [r.ok ? "Config is valid." : "Config has errors:", ...r.errors.map((e) => `  error: ${e}`), ...r.warnings.map((w) => `  warning: ${w}`)].join("\n"));
    return r.ok ? 0 : 1;
  }

  return withLock(root, null, `config ${sub}`, () => {
    const cfg = loadConfig(root);
    let summary: string;
    switch (sub) {
      case "set-role": {
        const role = roleArg(positionals[0]);
        const a = assignmentFrom(values, role, true);
        const prev = cfg.roles[role];
        cfg.roles[role] = { ...a, fallbacks: prev?.fallbacks ?? [], ...(role === "worker" ? { max_parallel: values["max-parallel"] ? Number(values["max-parallel"]) : (prev?.max_parallel ?? 3) } : {}) };
        summary = `${role}: ${a.mode} · ${a.agent} · ${a.model}`;
        break;
      }
      case "add-fallback": {
        const role = roleArg(positionals[0]);
        const rc = cfg.roles[role];
        if (!rc) throw new LrError("role_missing", `Configure ${role} first with: looprch config set-role ${role} ...`);
        const a = assignmentFrom(values, role, false);
        rc.fallbacks.push(a);
        summary = `${role}: fallback #${rc.fallbacks.length} ${a.mode} · ${a.agent} · ${a.model}`;
        break;
      }
      case "clear-fallbacks": {
        const role = roleArg(positionals[0]);
        const rc = cfg.roles[role];
        if (rc) rc.fallbacks = [];
        summary = `${role}: fallbacks cleared`;
        break;
      }
      case "set": {
        const [key, raw] = positionals;
        if (!key || raw === undefined) throw new UsageError("config set <key> <value>", USAGE);
        setKey(cfg, key, raw);
        summary = `${key} = ${raw}`;
        break;
      }
      default:
        throw new UsageError(`Unknown config subcommand "${sub}"`, USAGE);
    }
    const issues = validateConfig(cfg, validationContext(root, false));
    if (!issues.ok) throw new LrError("config_invalid", `Not saved: ${issues.errors.join("; ")}`, "Fix the values and run the command again", 1, issues);
    saveConfig(root, cfg);
    const report = emptyReport();
    syncAgentFiles(root, cfg, report);
    appendEvent(root, { type: "config.changed", data: { command: sub, summary } });
    out(json, { ok: true, summary, warnings: issues.warnings, regenerated: [...report.created, ...report.updated, ...report.removed], config: cfg }, () => [summary, ...issues.warnings.map((w) => `warning: ${w}`)].join("\n"));
    return 0;
  });
}
