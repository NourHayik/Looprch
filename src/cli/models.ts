import { AGENT_IDS, type AgentId } from "../core/config.js";
import { UsageError } from "../core/errors.js";
import { discoverClis, modelsFrom } from "../delegate/discover.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const usage = "looprch models <agent> [--refresh] [--json]";
  const { values, positionals } = parse(argv, { refresh: { type: "boolean" }, root: { type: "string" } }, usage);
  const agent = positionals[0];
  if (!agent || !(AGENT_IDS as readonly string[]).includes(agent)) throw new UsageError(`Name an agent: ${AGENT_IDS.join(", ")}`, usage);
  const d = discoverClis(projectRoot(values.root), !!values.refresh);
  const m = modelsFrom(d.data, agent as AgentId);
  const data = { agent, source: "discover", status: d.error ? "failed" : m.status, models: m.models, cached_at: d.at, error: d.error };
  out(!!values.json, data, () =>
    d.error
      ? `Model discovery failed: ${d.error}. Enter the model id the agent's own CLI reports.`
      : m.models.length
        ? `${agent} models (${m.status}, from delegate-setup discovery${d.cached ? ", cached" : ""}):\n${m.models.map((x) => `  ${x}`).join("\n")}`
        : `${agent} does not list its models (${m.status}). Enter the model id from the agent's own documentation or settings.`,
  );
  return 0;
}
