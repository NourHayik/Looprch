import { existsSync } from "node:fs";
import { VERSION } from "../core/constants.js";
import { loadConfig, reviewRounds } from "../core/config.js";
import { loadContract } from "../core/contract.js";
import { now } from "../core/clock.js";
import { readEvents, type LrEvent } from "../core/journal.js";
import { nextDescription } from "../core/lifecycle.js";
import { projectPaths } from "../core/paths.js";
import { loadRun, usageSummary } from "../core/runs.js";
import { ledgerSummary, loadLedger } from "../core/debate.js";
import { loadState } from "../core/state.js";
import { readManifest } from "../sev3/manifest.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

export function buildStatus(root: string) {
  const cfg = loadConfig(root);
  const st = loadState(root);
  const manifest = existsSync(projectPaths(root).manifest) ? readManifest(root) : null;
  const c = st.current;
  const closed = Object.values(st.phases).filter((p) => p.status === "closed").length;
  const run = c?.active_run ? loadRun(root, c.active_run) : null;
  const lastAccepted = readEvents(root, { type: "result.accepted", limit: 1 }).events[0] as LrEvent | undefined;
  const lastRun = lastAccepted?.run_id && existsSync(`${projectPaths(root).run(lastAccepted.run_id)}/run.json`) ? loadRun(root, lastAccepted.run_id) : null;
  const index = c && manifest ? manifest.phases.findIndex((p) => p.id === c.phase) + 1 : null;
  return {
    version: VERSION,
    project: { id: manifest?.project.id ?? cfg.project.id, title: manifest?.project.title ?? null },
    spec: { package_fingerprint: st.spec.package_fingerprint, phases_total: manifest?.phases.length ?? st.spec.phases_total, phases_closed: closed },
    current: c
      ? {
          phase: c.phase,
          title: c.title,
          index,
          stage: c.stage,
          round: c.round,
          cap: cfg.limits.repair_rounds + c.extra_rounds,
          test_repairs: c.test_repairs ?? 0,
          evidence_rounds: c.evidence_rounds ?? 0,
          review_changes: c.review_changes ?? 0,
          review_cap: reviewRounds(cfg) + (c.extra_reviews ?? 0),
          final_review_pending: !!c.final_review_pending,
          contract_revision: loadContract(root, c.phase)?.revision ?? null,
          design: c.design ?? null,
          work: c.work ? { kind: c.work.kind, total: c.work.items.length, done: c.work.done, next: c.work.items.find((w) => !c.work!.done.includes(w.id))?.id ?? null } : null,
          finding_ledger: c.finding_ledger ?? {},
        }
      : null,
    active: run
      ? { run_id: run.run_id, role: run.role, agent: run.agent, mode: run.mode, effective_mode: run.effective_mode, mode_reason: run.mode_reason, session_id: run.session_in, started_at: run.started_at, elapsed_s: Math.round((now() - Date.parse(run.started_at)) / 1000), status: run.status }
      : null,
    last_result: lastRun ? { role: lastRun.role, decision: lastRun.decision, summary: `${lastRun.role} ${lastRun.decision} (${lastRun.agent})`, touched_files: lastRun.touched_files.length } : null,
    flags: st.flags,
    pending_question: st.pending_question,
    project_status: st.project.status,
    next: { action: nextDescription(st), summary: nextDescription(st) },
    debate: c ? ledgerSummary(loadLedger(root, c.phase)) : null,
    usage: usageSummary(root, c?.phase ?? null),
  };
}

function kb(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n);
}

type Status = ReturnType<typeof buildStatus>;

export function humanStatus(s: Omit<Status, "debate" | "usage"> & Partial<Pick<Status, "debate" | "usage">>): string {
  const lines = [`Looprch ${s.version} · project ${s.project.id ?? "?"} · spec ${s.spec.phases_total} phases (fingerprint ${s.spec.package_fingerprint?.slice(0, 4) ?? "—"}…) · ${s.spec.phases_closed} closed`];
  if (s.current) lines.push(`Phase ${s.current.phase} (${s.current.index}/${s.spec.phases_total}) "${s.current.title}"  stage: ${s.current.stage}  repair round ${s.current.round} (test/gate repairs ${s.current.test_repairs}/${s.current.cap})  review changes ${s.current.review_changes}/${s.current.review_cap}`);
  else lines.push(s.project_status === "done" ? "Project complete." : "No phase in progress.");
  if (s.active) {
    const mode = s.active.mode_reason === "d05_auto_delegate" ? "direct→delegate" : s.active.effective_mode;
    lines.push(`Active: ${s.active.role} · ${s.active.agent} · ${mode} · session ${s.active.session_id?.slice(0, 8) ?? "new"} · ${s.active.status} for ${Math.round(s.active.elapsed_s / 60)} min`);
  }
  if (s.last_result) lines.push(`Last result: ${s.last_result.summary} · ${s.last_result.touched_files} files touched`);
  const blockers = s.flags.blocked ? `${s.flags.blocked.code}: ${s.flags.blocked.reason}` : s.flags.paused ? `paused: ${s.flags.paused.reason}` : s.flags.waiting ? `waiting until ${s.flags.waiting.until}` : "none";
  lines.push(`Blockers: ${blockers}${" ".repeat(4)}Next: ${s.next.summary}`);
  if (s.flags.blocked) lines.push(`Fix: ${s.flags.blocked.hint}`);
  for (const u of s.usage ?? [])
    lines.push(`Usage ${u.role} ${u.agent}/${u.model}: ${u.runs} run(s), ${Math.round(u.wall_ms / 60000)} min${u.runs_with_tokens ? `, tokens in ${kb(u.tokens.input)} (+${kb(u.tokens.cached_input)} cached) out ${kb(u.tokens.output)}` : ""}`);
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { root: { type: "string" } }, "looprch status [--json]");
  const s = buildStatus(projectRoot(values.root));
  out(!!values.json, s, () => humanStatus(s));
  return 0;
}

export async function runLog(argv: string[]): Promise<number> {
  const { values } = parse(argv, { phase: { type: "string" }, n: { type: "string", short: "n" }, type: { type: "string" }, root: { type: "string" } }, "looprch log [--phase P-NNN] [-n N] [--type <event>] [--json]");
  const r = readEvents(projectRoot(values.root), { phase: values.phase, type: values.type, limit: values.n ? Number(values.n) : 50 });
  out(!!values.json, r.events, () =>
    [...r.warnings.map((w) => `warning: ${w}`), ...r.events.map((e) => `${e.ts.slice(0, 19).replace("T", " ")}  ${String(e.seq).padStart(4)}  ${(e.phase ?? "").padEnd(6)} ${e.type.padEnd(20)} ${[e.role, e.agent, e.run_id].filter(Boolean).join(" · ")} ${summarize(e.data)}`)].join("\n"),
  );
  return 0;
}

function summarize(data: Record<string, unknown>): string {
  const keys = ["decision", "code", "reason", "label", "key", "tag", "kind", "until", "all_passed", "gate_id", "ok"];
  return keys
    .filter((k) => data[k] !== undefined)
    .map((k) => `${k}=${typeof data[k] === "string" ? (data[k] as string).slice(0, 60) : JSON.stringify(data[k])}`)
    .join(" ");
}
