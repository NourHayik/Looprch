import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, type AgentId, type Config, configExists, defaultConfig, loadConfig, saveConfig } from "../core/config.js";
import { GITHUB_SPEC } from "../core/constants.js";
import { LrError } from "../core/errors.js";
import { home, projectPaths } from "../core/paths.js";
import { adapterFor } from "../agents/index.js";
import { decideLinkModes, emptyReport, ensureSkillLinks, removeSkillLinks, type LinkReport } from "../install/links.js";
import { AGENTS_BEGIN, AGENTS_END, agentsMdBlock, GITIGNORE_BEGIN, GITIGNORE_END, gitignoreBlock, syncAgentFiles, upsertBlock } from "../install/project-files.js";
import { loadRegistry, upsertProject, type LinkMode } from "../install/registry.js";

/** Refuse Looprch 5.x layouts (never migrated, never overwritten). */
export function assertNot5x(root: string): void {
  const lr = projectPaths(root).lr;
  const vf = join(lr, "VERSION");
  const is5 = (existsSync(vf) && /^5\./.test(readFileSync(vf, "utf8").trim())) || existsSync(join(lr, "control"));
  if (is5)
    throw new LrError(
      "looprch5_layout",
      `${root} contains a Looprch 5.x .looprch/ folder`,
      "Looprch 0.x does not migrate 5.x state. Move the old .looprch/ folder away (keep a backup) before attaching.",
    );
}

export function assertCoreInstalled(): void {
  if (!existsSync(home.skills()))
    throw new LrError("core_not_installed", `Looprch is not installed centrally (${home.skills()} missing)`, `Run: npx ${GITHUB_SPEC} install (or node dist/looprch.mjs install --from . in a checkout)`);
}

export function parseAgents(list: string): AgentId[] {
  const ids = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) if (!(AGENT_IDS as readonly string[]).includes(id)) throw new LrError("unknown_agent", `Unknown agent "${id}"`, `Supported: ${AGENT_IDS.join(", ")}`, 2);
  return [...new Set(ids)] as AgentId[];
}

export interface AttachResult {
  root: string;
  existing_agents: AgentId[];
  added_agents: AgentId[];
  files: { created: string[]; updated: string[]; skipped_foreign: string[]; removed: string[] };
  link_mode: Record<string, LinkMode>;
  next_steps: { agent: AgentId; invoke: string; notes: string[] }[];
}

/** Shared layer: skill links, AGENTS.md block, .gitignore block, generated agent files, registry. */
export function applyProjectLayer(root: string, cfg: Config, forceCopy: boolean, report: LinkReport): Record<string, LinkMode> {
  const previous = loadRegistry().find((e) => e.path === root)?.link_mode ?? {};
  const modes = decideLinkModes(cfg.agents, forceCopy);
  for (const dir of Object.keys(modes)) if (previous[dir] === "copy") modes[dir] = "copy";
  for (const [dir, mode] of Object.entries(modes)) ensureSkillLinks(root, dir, mode, report);
  for (const dir of Object.keys(previous)) if (!(dir in modes)) removeSkillLinks(root, dir, report);
  const agentsMd = upsertBlock(join(root, "AGENTS.md"), AGENTS_BEGIN, AGENTS_END, agentsMdBlock());
  if (agentsMd === "created") report.created.push("AGENTS.md");
  else if (agentsMd === "updated") report.updated.push("AGENTS.md");
  const gi = upsertBlock(join(root, ".gitignore"), GITIGNORE_BEGIN, GITIGNORE_END, gitignoreBlock(cfg, Object.keys(modes)));
  if (gi === "created") report.created.push(".gitignore");
  else if (gi === "updated") report.updated.push(".gitignore");
  syncAgentFiles(root, cfg, report);
  upsertProject(root, cfg.agents, modes);
  return modes;
}

export function attach(root: string, add: AgentId[], forceCopy: boolean): AttachResult {
  assertNot5x(root);
  assertCoreInstalled();
  const isNew = !configExists(root);
  const cfg = isNew ? defaultConfig() : loadConfig(root);
  const existing = [...cfg.agents];
  const added = add.filter((a) => !existing.includes(a));
  cfg.agents = [...existing, ...added];
  const report = emptyReport();
  if (isNew || added.length) {
    saveConfig(root, cfg);
    if (isNew) report.created.push(".looprch/config.json");
    else report.updated.push(".looprch/config.json");
  }
  const modes = applyProjectLayer(root, cfg, forceCopy, report);
  return {
    root,
    existing_agents: existing,
    added_agents: added,
    files: report,
    link_mode: modes,
    next_steps: cfg.agents.map((id) => ({ agent: id, invoke: adapterFor(id).invoke("lr-init"), notes: adapterFor(id).postInstallNotes })),
  };
}
