import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fsx.js";
import { projectPaths } from "./paths.js";
import { isNonEmptyString, isObject, isStringArray, oneOf } from "./validate.js";
import type { State } from "./state.js";
import type { Manifest, PhaseDef } from "../sev3/manifest.js";

/** One task of the plan; plan.md describes how to do it. */
export interface Todo {
  id: string;
  title: string;
  /** The plan phase (section of plan.md) the todo belongs to, for example "1. Data model". */
  section?: string;
}

export interface Deferral {
  id: string;
  what: string;
  to_phase: string;
  /** Safe behavior in this phase until `to_phase` delivers. */
  interim?: string;
  requirements?: string[];
}

/** The machine-readable part of a plan; everything else lives in plan.md. */
export interface PlanBody {
  todos: Todo[];
  /** Implementer sessions: contiguous groups of todo ids, one Implementer run each. */
  sessions?: string[][];
  /** SEV3 requirement id -> todo or deferral ids that deliver it. */
  requirements?: Record<string, string[]>;
  deferrals?: Deferral[];
}

export interface Plan extends PlanBody {
  schema_version: 1;
  phase: string;
  revision: number;
}

export interface IncomingDeferral extends Deferral {
  from_phase: string;
  /** `P-NNN/X-n`. */
  ref: string;
}

const todoShape = (x: unknown): string | null => (isObject(x) && isNonEmptyString(x.id) && isNonEmptyString(x.title) ? null : 'each todo needs {"id", "title"}');

const deferralShape = (x: unknown): string | null => (isObject(x) && isNonEmptyString(x.id) && isNonEmptyString(x.what) && isNonEmptyString(x.to_phase) ? null : 'each deferral needs {"id", "what", "to_phase"}');

/** Shape of the `plan` object of a Planner result: only what Looprch needs to schedule the work. */
export function planShapeErrors(raw: unknown): string[] {
  if (!isObject(raw)) return ['plan is required: {"todos": [{"id": "T-1", "title": "..."}], "sessions": [["T-1"]]}'];
  const errors: string[] = [];
  if (!Array.isArray(raw.todos) || !raw.todos.length) errors.push("plan.todos must list the todos of the plan");
  else raw.todos.forEach((t, i) => {
    const e = todoShape(t);
    if (e) errors.push(`plan.todos[${i}]: ${e}`);
  });
  if (raw.sessions !== undefined && !(Array.isArray(raw.sessions) && raw.sessions.every(isStringArray))) errors.push('plan.sessions must be a list of todo id lists, for example [["T-1", "T-2"], ["T-3"]]');
  if (raw.requirements !== undefined && !(isObject(raw.requirements) && Object.values(raw.requirements).every(isStringArray))) errors.push("plan.requirements must map requirement ids to lists of todo or deferral ids");
  if (raw.deferrals !== undefined) {
    if (!Array.isArray(raw.deferrals)) errors.push("plan.deferrals must be a list");
    else raw.deferrals.forEach((d, i) => {
      const e = deferralShape(d);
      if (e) errors.push(`plan.deferrals[${i}]: ${e}`);
    });
  }
  return errors;
}

/** New todos a Planner context answer adds to the plan. */
export function todoListErrors(raw: unknown, key: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return [`${key} must be a list`];
  return raw.flatMap((t, i) => {
    const e = todoShape(t);
    return e ? [`${key}[${i}]: ${e}`] : [];
  });
}

/**
 * The sessions in todo order, repaired without asking anyone: unknown and repeated ids are
 * dropped, empty sessions removed, and todos no session lists are appended to the last session.
 */
export function normalizeSessions(body: PlanBody): { sessions: string[][]; notes: string[] } {
  const ids = body.todos.map((t) => t.id);
  const known = new Set(ids);
  const seen = new Set<string>();
  const notes: string[] = [];
  const sessions: string[][] = [];
  for (const s of body.sessions ?? []) {
    const kept: string[] = [];
    for (const id of s) {
      if (!known.has(id)) notes.push(`dropped unknown todo id ${id} from the sessions`);
      else if (!seen.has(id)) {
        seen.add(id);
        kept.push(id);
      }
    }
    if (kept.length) sessions.push(kept);
  }
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length) {
    if (sessions.length) {
      sessions[sessions.length - 1]!.push(...missing);
      if (body.sessions?.length) notes.push(`appended todos no session listed to the last session: ${missing.join(", ")}`);
    } else sessions.push(missing);
  }
  return { sessions, notes };
}

/** Requirement ids of the phase that the plan's requirement map does not mention (a hint for the Debater, never a check). */
export function unmappedRequirements(body: PlanBody | null, phase: PhaseDef): string[] {
  const mapped = new Set(Object.entries(body?.requirements ?? {}).filter(([, v]) => v.length).map(([k]) => k));
  for (const d of body?.deferrals ?? []) for (const r of d.requirements ?? []) mapped.add(r);
  return phase.requirements.filter((r) => !mapped.has(r));
}

export const DISPOSITIONS = ["accept", "reject"] as const;

export interface Disposition {
  id: string;
  decision: (typeof DISPOSITIONS)[number];
  note?: string;
}

export function dispositionShape(x: unknown): string | null {
  if (!isObject(x) || !isNonEmptyString(x.id)) return "needs id";
  if (!oneOf(x.decision, DISPOSITIONS)) return `${x.id}: decision must be accept or reject`;
  if (x.note !== undefined && typeof x.note !== "string") return `${x.id}: note must be a string`;
  return null;
}

export function planPath(root: string, phase: string): string {
  return join(projectPaths(root).phase(phase), "plan.json");
}

export function loadPlan(root: string, phase: string): Plan | null {
  return readJsonIfExists<Plan>(planPath(root, phase));
}

/** Write plan.json, keeping the previous version as plan.r<n>.json. */
export function savePlan(root: string, plan: Plan): string {
  const path = planPath(root, plan.phase);
  if (existsSync(path)) {
    let n = 0;
    while (existsSync(join(projectPaths(root).phase(plan.phase), `plan.r${n}.json`))) n++;
    copyFileSync(path, join(projectPaths(root).phase(plan.phase), `plan.r${n}.json`));
  }
  writeJsonAtomic(path, plan);
  return path;
}

export function newPlan(phase: string, body: PlanBody, revision = 1): Plan {
  return {
    schema_version: 1,
    phase,
    revision,
    todos: body.todos,
    ...(body.sessions ? { sessions: body.sessions } : {}),
    ...(body.requirements ? { requirements: body.requirements } : {}),
    ...(body.deferrals ? { deferrals: body.deferrals } : {}),
  };
}

/** Deferrals that closed phases made to `phaseId` (plan.json, or contract.json of phases closed before 0.8). */
export function incomingDeferrals(root: string, manifest: Manifest, st: State, phaseId: string): IncomingDeferral[] {
  const out: IncomingDeferral[] = [];
  for (const p of manifest.phases) {
    if (p.id === phaseId || st.phases[p.id]?.status !== "closed") continue;
    const dir = projectPaths(root).phase(p.id);
    const list = loadPlan(root, p.id)?.deferrals ?? readJsonIfExists<{ deferrals?: Deferral[] }>(join(dir, "contract.json"))?.deferrals ?? [];
    for (const d of list) if (d.to_phase === phaseId) out.push({ ...d, from_phase: p.id, ref: `${p.id}/${d.id}` });
  }
  return out;
}
