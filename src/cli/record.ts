import { readFileSync } from "node:fs";
import { LrError, UsageError } from "../core/errors.js";
import { withLock } from "../core/lock.js";
import { acceptResult, loadEngine, persist } from "../core/lifecycle.js";
import { progressStart, takeProgress } from "../core/journal.js";
import { loadRun } from "../core/runs.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = "looprch record <run_id> --stdin [--session <id>] [--json]   (pipe the Direct subagent's final message)";

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { stdin: { type: "boolean" }, session: { type: "string" }, root: { type: "string" } }, USAGE);
  const runId = positionals[0];
  if (!runId || !values.stdin) throw new UsageError("record needs a run id and --stdin", USAGE);
  const text = readFileSync(0, "utf8");
  const root = projectRoot(values.root);
  const r = await withLock(root, null, `record ${runId}`, () => {
    const from = progressStart(root);
    const e = loadEngine(root, null);
    const run = loadRun(root, runId);
    if (run.status !== "issued") throw new LrError("run_not_open", `Run ${runId} is ${run.status}; nothing to record`, "Run looprch next for the current action");
    if (run.effective_mode !== "direct") throw new LrError("not_direct", `Run ${runId} is a Delegate run; use looprch dispatch ${runId}`);
    if (!run.side && e.st.current?.active_run !== runId) throw new LrError("stale_run", `Run ${runId} is not the active run (${e.st.current?.active_run ?? "none"})`, "Run looprch next");
    const outcome = acceptResult(e, run, text, values.session ?? null);
    persist(e);
    const progress = run.side ? [] : takeProgress(root, from);
    return { ok: outcome.status === "accepted", run_id: runId, ...outcome, next_hint: "looprch next", progress };
  });
  out(!!values.json, r, () => [...r.progress, `${runId}: ${r.status}${r.decision ? ` (${r.decision})` : ""}${r.errors.length ? `\n${r.errors.join("\n")}` : ""}\nContinue with: looprch next`].join("\n"));
  return 0;
}
