import { AGENT_IDS, type AgentId } from "../core/config.js";
import { UsageError } from "../core/errors.js";
import { withLock } from "../core/lock.js";
import { issueSideRun, loadEngine, persist } from "../core/lifecycle.js";
import { parse, projectRoot } from "./args.js";
import { humanAction } from "./next.js";
import { out } from "./output.js";

function hostArg(v: string | undefined, usage: string): AgentId {
  if (!v || !(AGENT_IDS as readonly string[]).includes(v)) throw new UsageError(`--host is required (${AGENT_IDS.join(", ")})`, usage);
  return v as AgentId;
}

export async function runWorker(argv: string[]): Promise<number> {
  const usage = 'looprch worker "<question>" --host <agent> [--json]';
  const { values, positionals } = parse(argv, { host: { type: "string" }, root: { type: "string" } }, usage);
  const question = positionals.join(" ").trim();
  if (!question) throw new UsageError("Ask a bounded question", usage);
  const host = hostArg(values.host, usage);
  const root = projectRoot(values.root);
  const action = await withLock(root, host, "worker", () => {
    const e = loadEngine(root, host);
    const a = issueSideRun(e, "worker", { question });
    persist(e);
    return a;
  });
  out(!!values.json, action, () => humanAction(action));
  return 0;
}

export async function runReview(argv: string[]): Promise<number> {
  const usage = "looprch review [P-NNN] --host <agent> [--json]";
  const { values, positionals } = parse(argv, { host: { type: "string" }, root: { type: "string" } }, usage);
  const host = hostArg(values.host, usage);
  const root = projectRoot(values.root);
  const phase = positionals[0];
  if (phase && !/^P-\d{3,}$/.test(phase)) throw new UsageError("Phase ids look like P-001", usage);
  const action = await withLock(root, host, "review", () => {
    const e = loadEngine(root, host);
    const a = issueSideRun(e, "adhoc_review", { phase });
    persist(e);
    return a;
  });
  out(!!values.json, action, () => humanAction(action));
  return 0;
}
