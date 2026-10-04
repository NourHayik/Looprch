import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_IDS, type AgentId, configExists, loadConfig } from "../core/config.js";
import { UsageError } from "../core/errors.js";
import { adapterFor, detectBinary } from "../agents/index.js";
import { askAgents } from "../ui/prompts.js";
import { parse } from "./args.js";
import { assertCoreInstalled, assertNot5x, attach, parseAgents } from "./attach.js";
import { out } from "./output.js";

const USAGE = "looprch add [path] [--agents codex,cursor] [--yes] [--copy] [--json]";

function resolveRoot(path: string | undefined): string {
  const start = resolve(path ?? process.cwd());
  if (!existsSync(start)) throw new UsageError(`No such directory: ${start}`);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: start, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || start;
  } catch {
    return start;
  }
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { agents: { type: "string" }, yes: { type: "boolean", short: "y" }, copy: { type: "boolean" } }, USAGE);
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const root = resolveRoot(positionals[0]);
  assertNot5x(root);
  assertCoreInstalled();
  const enabled: AgentId[] = configExists(root) ? loadConfig(root).agents : [];
  let selection: AgentId[];
  if (values.agents) selection = parseAgents(values.agents);
  else if (values.yes) selection = [];
  else {
    const remaining = AGENT_IDS.filter((id) => !enabled.includes(id));
    selection = (await askAgents(
      enabled.map((id) => adapterFor(id).displayName),
      remaining.map((id) => ({ value: id, label: adapterFor(id).displayName, hint: detectBinary(adapterFor(id)) ? "installed" : "not found on PATH" })),
    )) as AgentId[];
  }
  if (!configExists(root) && selection.length === 0) throw new UsageError("Select at least one agent for a new project", USAGE);
  const r = attach(root, selection, !!values.copy);
  out(!!values.json, r, () => {
    const lines = [`Looprch attached to ${r.root}`];
    if (r.existing_agents.length) lines.push(`Enabled before: ${r.existing_agents.join(", ")}`);
    lines.push(r.added_agents.length ? `Added: ${r.added_agents.join(", ")}` : "No new agents; links and files repaired.");
    for (const [dir, mode] of Object.entries(r.link_mode)) lines.push(`Skills in ${dir}: ${mode}`);
    if (r.files.created.length) lines.push(`Created: ${r.files.created.length} file(s)`);
    if (r.files.updated.length) lines.push(`Updated: ${r.files.updated.join(", ")}`);
    if (r.files.skipped_foreign.length) lines.push(`Not touched (not created by Looprch): ${r.files.skipped_foreign.join(", ")}`);
    lines.push("", "Next: open the project in your agent and run /lr-init:");
    for (const s of r.next_steps) {
      lines.push(`  ${adapterFor(s.agent).displayName}: ${s.invoke}`);
      for (const n of s.notes) lines.push(`    - ${n}`);
    }
    return lines.join("\n");
  });
  return 0;
}
