import { AGENT_IDS, type AgentId, loadConfig, saveConfig } from "../core/config.js";
import { LrError, UsageError } from "../core/errors.js";
import { emptyReport } from "../install/links.js";
import { appendEvent } from "../core/journal.js";
import { parse, projectRoot } from "./args.js";
import { applyProjectLayer } from "./attach.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const usage = "looprch remove <agent> [--root <dir>] [--json]";
  const { values, positionals } = parse(argv, { root: { type: "string" } }, usage);
  const agent = positionals[0] as AgentId | undefined;
  if (!agent || !(AGENT_IDS as readonly string[]).includes(agent)) throw new UsageError("Name one agent to remove", usage);
  const root = projectRoot(values.root);
  const cfg = loadConfig(root);
  if (!cfg.agents.includes(agent)) throw new LrError("not_enabled", `${agent} is not enabled in this project`);
  const roles = Object.entries(cfg.roles)
    .filter(([, rc]) => rc && [rc, ...rc.fallbacks].some((a) => a.agent === agent))
    .map(([r]) => r);
  if (roles.length)
    throw new LrError("agent_in_use", `${agent} is still used by: ${roles.join(", ")}`, `Reassign first, e.g.: looprch config set-role ${roles[0]} --mode delegate --agent <other> --model <model>`, 1, { roles });
  cfg.agents = cfg.agents.filter((a) => a !== agent);
  if (cfg.lead_host === agent) cfg.lead_host = null;
  saveConfig(root, cfg);
  const report = emptyReport();
  applyProjectLayer(root, cfg, false, report);
  appendEvent(root, { type: "config.changed", data: { removed_agent: agent } });
  out(!!values.json, { removed_agent: agent, removed_files: report.removed }, `Removed ${agent}. Deleted ${report.removed.length} Looprch-owned file(s).`);
  return 0;
}
