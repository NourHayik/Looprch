import { existsSync, readFileSync } from "node:fs";
import { LrError, UsageError } from "../core/errors.js";
import { checkResult, loadEngine, reportPath } from "../core/lifecycle.js";
import { loadRun } from "../core/runs.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = `looprch check <run_id> [--stdin | --file <path>] [--root <dir>] [--json]
  Check a role's report the way Looprch will when the run ends: the looprch-result block, its
  shape, the task's decisions and the phase rules (contract coverage, plan lint, dispositions,
  verifications, review coverage). Changes nothing. Without --stdin or --file it reads the run's
  report file .looprch/runs/<run_id>/report.md. A block without markdown above it is checked
  without the rules about the markdown (plan sections, blueprints, ## Coverage).`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { root: { type: "string" }, stdin: { type: "boolean" }, file: { type: "string" } }, USAGE);
  const runId = positionals[0];
  if (!runId) throw new UsageError("Name the run: looprch check <run_id>", USAGE);
  const root = projectRoot(values.root);
  const e = loadEngine(root, null);
  const run = loadRun(root, runId);
  if (run.status !== "issued" && run.status !== "running") throw new LrError("run_finished", `Run ${runId} already ended (${run.status})`, "Only the role of an active run checks its report");
  let text: string;
  if (values.stdin) text = await readStdin();
  else {
    const path = values.file ?? reportPath(e, runId);
    if (!existsSync(path)) throw new LrError("no_report", `No report at ${path}`, `Write your report to ${reportPath(e, runId)} or pass --stdin`);
    text = readFileSync(path, "utf8");
  }
  const r = checkResult(e, run, text);
  out(!!values.json, r, () => (r.ok ? `ok: the report passes Looprch's checks (decision ${r.decision}).` : ["The report would be rejected. Fix each problem, then check again:", ...r.errors.map((x) => `  - ${x}`)].join("\n")));
  return r.ok ? 0 : 1;
}
