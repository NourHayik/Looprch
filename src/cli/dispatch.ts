import { join } from "node:path";
import { LrError, UsageError } from "../core/errors.js";
import { writeFileAtomic } from "../core/fsx.js";
import { projectPaths } from "../core/paths.js";
import { loadConfig } from "../core/config.js";
import { parseDuration } from "../core/clock.js";
import { withLock } from "../core/lock.js";
import { block, loadEngine, persist } from "../core/lifecycle.js";
import { appendEvent } from "../core/journal.js";
import { loadRun, saveRun, type RunRecord } from "../core/runs.js";
import { nowIso } from "../core/clock.js";
import { buildRelayArgv, finalizeWithLock, relayWrapper, spawnWrapper, waitForRun } from "../delegate/dispatch.js";
import { locateRelay } from "../delegate/locate.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = "looprch dispatch <run_id> [--max-wait 10m] [--json]\nlooprch dispatch --wait <run_id> [--max-wait 10m] [--json]";

function report(run: RunRecord, done: boolean) {
  return {
    run_id: run.run_id,
    status: done ? run.status : "running",
    recorded: run.status !== "running" && run.status !== "issued",
    decision: run.decision,
    session_id: run.session_out,
    agent: run.agent,
    error: run.error ?? null,
    output_path: run.output_path ?? null,
    next: "looprch next",
  };
}

export async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { wait: { type: "string" }, "max-wait": { type: "string" }, root: { type: "string" } }, USAGE);
  const root = projectRoot(values.root);
  const runId = values.wait ?? positionals[0];
  if (!runId) throw new UsageError("Name the run to dispatch", USAGE);
  const maxMs = parseDuration(values["max-wait"] ?? loadConfig(root).limits.dispatch_max_wait);
  if (!values.wait) {
    const started = await withLock(root, null, `dispatch ${runId}`, () => {
      const r = loadRun(root, runId);
      if (r.status !== "issued") return r.status === "running";
      if (r.effective_mode !== "delegate") throw new LrError("not_delegate", `Run ${runId} is Direct: spawn your native subagent and pipe its final message into looprch record ${runId} --stdin`);
      const relay = locateRelay(root, r.agent);
      if (!relay) {
        const e = loadEngine(root, null);
        block(e, "relay_missing", `${r.agent}-delegate is not installed`, `looprch install-relay ${r.agent}`);
        persist(e);
        throw new LrError("relay_missing", `${r.agent}-delegate is not installed`, `looprch install-relay ${r.agent}`);
      }
      const { argv: relayArgv, warnings } = buildRelayArgv(root, r, relay);
      r.argv = relayArgv;
      r.relay_path = relay.path;
      r.relay_sha256 = relay.sha256;
      r.status = "running";
      r.started_at = nowIso();
      saveRun(root, r);
      r.pid = spawnWrapper(root, runId);
      saveRun(root, r);
      appendEvent(root, { type: "run.dispatched", phase: r.phase, role: r.role, agent: r.agent, run_id: r.run_id, data: { pid: r.pid, relay: relay.path, relay_version: relay.version, argv: relayArgv.slice(1) } });
      for (const w of warnings) appendEvent(root, { type: "warning", phase: r.phase, role: r.role, agent: r.agent, run_id: r.run_id, data: { message: w } });
      return true;
    });
    if (!started) {
      const r = loadRun(root, runId);
      out(!!values.json, report(r, true), `Run ${runId} already finished: ${r.status}`);
      return 0;
    }
  }
  const done = await waitForRun(root, runId, maxMs);
  if (done) await finalizeWithLock(root, runId);
  const r = loadRun(root, runId);
  const data = report(r, done && r.status !== "running");
  out(!!values.json, data, () => (data.status === "running" ? `Run ${runId} is still running in ${r.agent}. Check again with: looprch dispatch --wait ${runId}` : `Run ${runId}: ${data.status}${data.decision ? ` (${data.decision})` : ""}. Continue with: looprch next`));
  return 0;
}

export async function runWrapper(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { root: { type: "string" } }, "looprch _run-relay <run_id> --root <dir>");
  const root = projectRoot(values.root);
  try {
    return await relayWrapper(root, positionals[0]!);
  } catch (err) {
    writeFileAtomic(join(projectPaths(root).run(positionals[0]!), "wrapper.error"), `${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}
