import { LrError, UsageError } from "../core/errors.js";
import { withLock } from "../core/lock.js";
import { applyGates, loadEngine, persist, type GateExtras } from "../core/lifecycle.js";
import { e2eSelected, runE2eGate } from "../gates/e2e.js";
import { testIntegrityProblems } from "../gates/integrity.js";
import { cachedOutcome, extraRunSlot, recordExtraRun, runPhaseGates } from "../gates/runner.js";
import { head } from "../git/git.js";
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
    const outcome = cachedOutcome(root, phase, tested) ?? runPhaseGates(root, e.cfg, phase, tested, c.manual_reports);
    const extras: GateExtras = {};
    if (outcome.all_passed && c.phase_base) extras.integrity = testIntegrityProblems(root, c.phase_base, tested);
    const e2e = e.cfg.integrations.e2e;
    if (outcome.all_passed && !extras.integrity?.length && e2eSelected(e2e, c.phase) && c.e2e_passed_tree !== tested) {
      const slot = extraRunSlot(root, c.phase);
      const er = runE2eGate(root, e.cfg, e2e, slot.gateRunId, slot.outDir, tested, head(root));
      recordExtraRun(root, c.phase, er.run);
      outcome.runs.push(er.run);
      outcome.results.push({ gate_run_id: er.run.gate_run_id, gate_id: er.run.gate_id, ok: er.run.ok, reason: er.run.reason });
      if (!er.run.ok) outcome.all_passed = false;
      extras.e2e = { outcome: er.outcome, reason: er.run.reason, tree: tested };
    }
    outcome.snapshot_tree = snapshotTree(root);
    applyGates(e, outcome, extras);
    persist(e);
    return { phase: outcome.phase, snapshot_tree: outcome.snapshot_tree, all_passed: outcome.all_passed, cached: !!outcome.cached, results: outcome.results, next_stage: e.st.current?.stage ?? null };
  });
  out(!!values.json, r, () => [...r.results.map((x) => `${x.ok ? "pass" : "FAIL"} ${x.gate_id} (${x.gate_run_id})${x.reason ? `: ${x.reason}` : ""}`), ...(r.cached ? ["(cached: the gates already passed on this exact tree)"] : []), `Next stage: ${r.next_stage}`].join("\n"));
  return 0;
}
