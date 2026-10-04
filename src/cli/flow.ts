import { UsageError } from "../core/errors.js";
import { now, parseDuration, sleep } from "../core/clock.js";
import { withLock } from "../core/lock.js";
import { answer, doCheckpoint, loadEngine, pause, persist, resume } from "../core/lifecycle.js";
import { loadState } from "../core/state.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

export async function runAnswer(argv: string[]): Promise<number> {
  const usage = "looprch answer <question_id> <option_id> [--text <s>] [--json]";
  const { values, positionals } = parse(argv, { text: { type: "string" }, root: { type: "string" } }, usage);
  const [qid, option] = positionals;
  if (!qid || !option) throw new UsageError("answer needs a question id and an option id", usage);
  const root = projectRoot(values.root);
  const r = await withLock(root, null, "answer", () => {
    const e = loadEngine(root, null);
    answer(e, qid, option, values.text ?? null);
    persist(e);
    return { ok: true, question_id: qid, option };
  });
  out(!!values.json, r, `Recorded ${option} for ${qid}. Continue with: looprch next`);
  return 0;
}

export async function runWait(argv: string[]): Promise<number> {
  const { values } = parse(argv, { max: { type: "string" }, root: { type: "string" } }, "looprch wait [--max 10m] [--json]");
  const root = projectRoot(values.root);
  const w = loadState(root).flags.waiting;
  if (!w) {
    out(!!values.json, { until: null, done: true }, "Nothing to wait for.");
    return 0;
  }
  const remaining = Date.parse(w.until) - now();
  const max = parseDuration(values.max ?? "10m");
  if (remaining > 0) await sleep(Math.min(remaining, max));
  const done = now() >= Date.parse(w.until);
  out(!!values.json, { until: w.until, done }, done ? "Wait is over. Continue with: looprch next" : `Still waiting until ${w.until}. Run looprch wait again.`);
  return 0;
}

export async function runPause(argv: string[]): Promise<number> {
  const { values } = parse(argv, { root: { type: "string" } }, "looprch pause [--json]");
  const root = projectRoot(values.root);
  await withLock(root, null, "pause", () => {
    const e = loadEngine(root, null);
    pause(e);
    persist(e);
  });
  out(!!values.json, { pause_requested: true }, "Pause requested: Looprch stops at the next step boundary (a running role finishes first).");
  return 0;
}

export async function runResume(argv: string[]): Promise<number> {
  const { values } = parse(argv, { note: { type: "string" }, root: { type: "string" } }, 'looprch resume [--note "<instruction>"] [--json]');
  const root = projectRoot(values.root);
  const r = await withLock(root, null, "resume", () => {
    const e = loadEngine(root, null);
    const cleared = resume(e, values.note ?? null);
    persist(e);
    return { cleared, note_recorded: !!values.note && !!e.st.current, scope: e.st.scope };
  });
  out(!!values.json, r, `Resumed (${r.cleared.join(", ") || "nothing to clear"}). Continue with: looprch next --scope ${r.scope}`);
  return 0;
}

export async function runCheckpoint(argv: string[]): Promise<number> {
  const { values } = parse(argv, { root: { type: "string" } }, "looprch checkpoint [--json]");
  const root = projectRoot(values.root);
  const r = await withLock(root, null, "checkpoint", () => {
    const e = loadEngine(root, null);
    const res = doCheckpoint(e);
    persist(e);
    return { label: res.label, commit: res.commit, skipped_empty: !!res.label && !res.commit && !e.st.flags.blocked, blocked: e.st.flags.blocked?.code ?? null };
  });
  out(!!values.json, r, r.label ? (r.commit ? `Checkpoint ${r.commit.slice(0, 10)}: ${r.label}` : r.blocked ? `Checkpoint failed (${r.blocked}); see looprch next` : `Nothing to commit for: ${r.label}`) : "No checkpoint pending.");
  return 0;
}
