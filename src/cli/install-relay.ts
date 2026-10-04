import { spawnSync } from "node:child_process";
import { AGENT_IDS, type AgentId } from "../core/config.js";
import { LrError, UsageError } from "../core/errors.js";
import { adapterFor } from "../agents/index.js";
import { locateRelay, relayInstallArgv } from "../delegate/locate.js";
import { askConfirm } from "../ui/prompts.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const usage = "looprch install-relay <agent> [--yes] [--json]";
  const { values, positionals } = parse(argv, { yes: { type: "boolean", short: "y" }, root: { type: "string" } }, usage);
  const agent = positionals[0] as AgentId | undefined;
  if (!agent || !(AGENT_IDS as readonly string[]).includes(agent)) throw new UsageError(`Name an agent: ${AGENT_IDS.join(", ")}`, usage);
  if (!adapterFor(agent).delegate) throw new LrError("delegate_unsupported", `${agent} has no delegate-skills relay`);
  const root = projectRoot(values.root);
  const existing = locateRelay(root, agent);
  if (existing) {
    out(!!values.json, { agent, installed: false, already_present: true, relay: existing }, `${existing.skill} is already installed at ${existing.path}`);
    return 0;
  }
  const args = relayInstallArgv(agent);
  if (!(await askConfirm(`Install ${adapterFor(agent).delegate!.skill} globally with: npx ${args.join(" ")}?`, !!values.yes))) throw new LrError("cancelled", "Not installed");
  const r = spawnSync("npx", args, { encoding: "utf8", env: { ...process.env, DISABLE_TELEMETRY: "1" }, timeout: 300_000 });
  const relay = locateRelay(root, agent);
  if (r.status !== 0 || !relay) throw new LrError("relay_install_failed", `Installing ${agent}-delegate failed`, "Install it manually: DISABLE_TELEMETRY=1 npx " + args.join(" "), 1, (r.stderr || r.stdout || "").slice(-2000));
  out(!!values.json, { agent, installed: true, argv: ["npx", ...args], relay }, `Installed ${relay.skill} at ${relay.path}`);
  return 0;
}
