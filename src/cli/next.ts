import { AGENT_IDS, type AgentId } from "../core/config.js";
import { PROTOCOL } from "../core/constants.js";
import { UsageError } from "../core/errors.js";
import { withLock } from "../core/lock.js";
import { loadEngine, next, persist, type Engine } from "../core/lifecycle.js";
import { progressStart, takeProgress } from "../core/journal.js";
import { stopsLoop, type Action } from "../core/actions.js";
import type { Scope } from "../core/state.js";
import { detectHosts } from "../agents/index.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = `looprch next --host <agent> [--scope phase|auto|finish] [--json]
  --host   the agent the Lead runs in: ${AGENT_IDS.join(", ")}
  --scope  phase (stop after one phase), auto (stop before the closure phase), finish (closure phase + project closure)`;

export function humanAction(a: Action & { progress?: string[] }): string {
  const lines = [...(a.progress ?? []), `${a.action}: ${a.summary}`];
  if (a.command) lines.push(`run: ${a.command.join(" ")}`);
  if (a.action === "run_role" && a.record_command) lines.push(`then: ${a.record_command.join(" ")} < final-message`);
  if (a.action === "ask_user") lines.push(...a.options.map((o) => `  ${o.id}: ${o.label}`), `answer: looprch answer ${a.question_id} <option>`);
  if (a.action === "blocked") lines.push(`fix: ${a.hint}`);
  if (stopsLoop(a)) lines.push("(the Lead stops here)");
  return lines.join("\n");
}

function decide(e: Engine, host: AgentId, scope: Scope | undefined): Action {
  if (!e.cfg.agents.includes(host)) {
    const reason = `${host} is not enabled in this project`;
    return { protocol: PROTOCOL, phase: e.st.current?.phase ?? null, stage: e.st.current?.stage ?? null, round: 0, summary: reason, action: "blocked", code: "host_not_enabled", reason, details: null, hint: `Run: looprch add . --agents ${host}`, durable: false } satisfies Action;
  }
  const detected = detectHosts();
  if (detected.length && !detected.includes(host) && !e.st.pending_question) {
    const qid = `host_conflict-${host}-${detected.join("+")}`;
    const ans = e.st.answers[qid];
    if (ans === "detected") {
      delete e.st.answers[qid];
      const reason = `Rerun with --host ${detected[0]}`;
      return { protocol: PROTOCOL, phase: e.st.current?.phase ?? null, stage: e.st.current?.stage ?? null, round: 0, summary: reason, action: "blocked", code: "host_not_enabled", reason, details: null, hint: `looprch next --host ${detected[0]}`, durable: false } satisfies Action;
    }
    if (!ans) {
      e.st.pending_question = {
        id: qid,
        kind: "host_conflict",
        question: `You declared host ${host}, but the environment looks like ${detected.join(" or ")}. Which agent is the Lead running in?`,
        options: [
          { id: "declared", label: `${host} (as declared)` },
          { id: "detected", label: `${detected[0]} (I will rerun with --host ${detected[0]})` },
        ],
        context: { host, detected },
      };
    }
  }
  return next(e, scope);
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { host: { type: "string" }, scope: { type: "string" }, root: { type: "string" } }, USAGE);
  const host = values.host;
  if (!host || !(AGENT_IDS as readonly string[]).includes(host)) throw new UsageError(`--host is required (${AGENT_IDS.join(", ")})`, USAGE);
  const scope = values.scope as Scope | undefined;
  if (scope && !["phase", "auto", "finish"].includes(scope)) throw new UsageError("--scope must be phase, auto or finish", USAGE);
  const root = projectRoot(values.root);
  const action = await withLock(root, host, "next", (reclaimed) => {
    const from = progressStart(root);
    const e = loadEngine(root, host as AgentId);
    if (reclaimed) e.events.push({ type: "lock.stale_recovered", data: {} });
    const a = decide(e, host as AgentId, scope);
    persist(e);
    return { ...a, progress: takeProgress(root, from) };
  });
  out(!!values.json, action, () => humanAction(action));
  return 0;
}
