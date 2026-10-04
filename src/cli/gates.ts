import { LrError, UsageError } from "../core/errors.js";
import { withLock } from "../core/lock.js";
import { applyGates, loadEngine, persist } from "../core/lifecycle.js";
import { runPhaseGates } from "../gates/runner.js";
import { snapshotTree } from "../git/snapshot.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = "looprch gates run [--phase P-NNN] [--json]";

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "run") throw new UsageError("Only `looprch gates run` exists", USAGE);
  const { values } = parse(rest, { phase: { type: "string" }, root: { type: "string" } }, USAGE);
  const root = projectRoot(values.root);
  const r = await withLock(root, null, "gates run", () => {
    const e = loadEngine(root, null);
    const c = e.st.current;
    if (!c || c.stage !== "gating") throw new LrError("not_gating", `Looprch is not expecting gates now (${c ? `stage ${c.stage}` : "no phase in progress"})`, "Run looprch next");
    if (values.phase && values.phase !== c.phase) throw new LrError("wrong_phase", `The current phase is ${c.phase}`);
    const phase = e.manifest.phases.find((p) => p.id === c.phase)!;
    const tested = snapshotTree(root);
    const outcome = runPhaseGates(root, e.cfg, phase, tested, c.manual_reports);
    outcome.snapshot_tree = snapshotTree(root);
    applyGates(e, outcome);
    persist(e);
    return { phase: outcome.phase, snapshot_tree: outcome.snapshot_tree, all_passed: outcome.all_passed, results: outcome.results, next_stage: e.st.current?.stage ?? null };
  });
  out(!!values.json, r, () => [...r.results.map((x) => `${x.ok ? "pass" : "FAIL"} ${x.gate_id} (${x.gate_run_id})${x.reason ? `: ${x.reason}` : ""}`), `Next stage: ${r.next_stage}`].join("\n"));
  return 0;
}
