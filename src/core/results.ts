import { isNonEmptyString, isObject, isStringArray, oneOf } from "./validate.js";
import { FINDING_OWNERS, type FindingOwner } from "./state.js";
import { dispositionShape, planShapeErrors, todoListErrors, type Disposition, type PlanBody, type Todo } from "./plan.js";
import { VERDICTS, type Verdict } from "./debate.js";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const RESOLUTION_STATUSES = ["fixed", "not_fixed"] as const;

export const DECISIONS = {
  planner: ["plan_ready", "plan_final", "needs_expansion", "context_answer"],
  plan_debater: ["no_findings", "findings", "agree", "needs_expansion"],
  implementer: ["implemented", "needs_context", "handover_ready"],
  tester: ["pass", "fail"],
  reviewer: ["approve", "changes_requested"],
  worker: ["answered"],
} as const;

export type ResultRole = keyof typeof DECISIONS;

export interface ExpansionRequest {
  kind: "document" | "phase";
  id: string;
  question: string;
  reason: string;
}

export interface ResultFinding {
  id: string;
  severity?: string;
  summary: string;
  files?: string[];
  /** Plan Debater: the plan section it concerns. */
  section?: string;
  /** Plan Debater: the change that would close it. */
  suggestion?: string;
  /** Reviewer: the condition a repair must meet. */
  fix?: string;
  owner?: FindingOwner;
}

export interface Resolution {
  id: string;
  status: (typeof RESOLUTION_STATUSES)[number];
  note?: string;
}

export interface RoleResult {
  role: ResultRole;
  decision: string;
  run_id?: string;
  findings?: ResultFinding[];
  resolutions?: Resolution[];
  failures?: { id: string; gate_id?: string; summary: string; files?: string[] }[];
  expansion_requests?: ExpansionRequest[];
  files_changed?: string[];
  context_request?: { question: string; reason: string };
  tests_written?: string[];
  manual_gate_reports?: { gate_id: string; path: string }[];
  limitations?: string[];
  evidence?: { path: string; lines?: string; note: string }[];
  /** Planner: todos, Implementer sessions, requirement map, deferrals. */
  plan?: PlanBody;
  debate_dispositions?: Disposition[];
  /** Planner context answer: todos it adds to the current session. */
  new_todos?: Todo[];
  /** Plan Debater, rebuttal: its verdict on the Planner's answer to open items. */
  verdicts?: { id: string; verdict: Verdict; note?: string }[];
  /** Implementer: the todos of its session it finished. */
  todos_done?: string[];
  /** Implementer: choices it made where the plan left a small gap, and anything the next role should know. */
  notes?: string[] | string;
}

export interface Extracted {
  ok: boolean;
  json: unknown;
  artifact: string;
  error: string | null;
}

const FENCE = /```looprch-result[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

/** The last fenced `looprch-result` block; the markdown above it is the stage artifact. */
export function extractResultBlock(text: string): Extracted {
  const matches = [...text.matchAll(FENCE)];
  if (matches.length === 0) return { ok: false, json: null, artifact: text.trim(), error: "No ```looprch-result block found at the end of the message" };
  const last = matches[matches.length - 1]!;
  const artifact = text.slice(0, last.index).trim();
  try {
    return { ok: true, json: JSON.parse(last[1]!), artifact, error: null };
  } catch (err) {
    return { ok: false, json: null, artifact, error: `The looprch-result block is not valid JSON: ${(err as Error).message}` };
  }
}

function checkList(errors: string[], obj: Record<string, unknown>, key: string, item: (v: unknown) => string | null): void {
  const v = obj[key];
  if (v === undefined) return;
  if (!Array.isArray(v)) {
    errors.push(`${key} must be a list`);
    return;
  }
  v.forEach((x, i) => {
    const e = item(x);
    if (e) errors.push(`${key}[${i}]: ${e}`);
  });
}

const finding = (x: unknown) => {
  if (!isObject(x)) return "must be an object";
  if (!isNonEmptyString(x.id)) return "id is required";
  if (!isNonEmptyString(x.summary)) return "summary is required";
  if (x.severity !== undefined && !oneOf(x.severity, SEVERITIES)) return `severity must be one of ${SEVERITIES.join(", ")}`;
  if (x.files !== undefined && !isStringArray(x.files)) return "files must be a list of paths";
  if (x.owner !== undefined && !oneOf(x.owner, FINDING_OWNERS)) return `owner must be one of ${FINDING_OWNERS.join(", ")}`;
  return null;
};

const resolution = (x: unknown) => {
  if (!isObject(x) || !isNonEmptyString(x.id)) return "needs id";
  if (!oneOf(x.status, RESOLUTION_STATUSES)) return `status must be one of ${RESOLUTION_STATUSES.join(", ")}`;
  return null;
};

const expansion = (x: unknown) => {
  if (!isObject(x)) return "must be an object";
  if (!oneOf(x.kind, ["document", "phase"] as const)) return 'kind must be "document" or "phase"';
  if (!isNonEmptyString(x.id) || !isNonEmptyString(x.question) || !isNonEmptyString(x.reason)) return "id, question and reason are required";
  return null;
};

const strings = (x: unknown) => (typeof x === "string" ? null : "must be a string");
const gateReport = (x: unknown) => (isObject(x) && isNonEmptyString(x.gate_id) && isNonEmptyString(x.path) ? null : "needs gate_id and path");

/** The result block's shape: only what Looprch needs to read the answer and continue. */
export function validateResult(expectedRole: ResultRole, raw: unknown, runId?: string): { ok: true; result: RoleResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["the block must contain one JSON object"] };
  if (raw.role !== expectedRole) errors.push(`role must be "${expectedRole}" (got ${JSON.stringify(raw.role)})`);
  const allowed = DECISIONS[expectedRole] as readonly string[];
  if (!oneOf(raw.decision, allowed)) errors.push(`decision must be one of ${allowed.join(", ")}`);
  if (raw.run_id !== undefined && runId && raw.run_id !== runId) errors.push(`run_id must be "${runId}"`);
  checkList(errors, raw, "expansion_requests", expansion);
  if (raw.decision === "needs_expansion" && (!Array.isArray(raw.expansion_requests) || !raw.expansion_requests.length)) errors.push('decision needs_expansion needs "expansion_requests" naming SEV3 document or phase ids');
  switch (expectedRole) {
    case "planner":
      if (raw.decision === "plan_ready" || raw.decision === "plan_final") errors.push(...planShapeErrors(raw.plan));
      checkList(errors, raw, "debate_dispositions", dispositionShape);
      errors.push(...todoListErrors(raw.new_todos, "new_todos"));
      break;
    case "plan_debater":
      checkList(errors, raw, "findings", finding);
      checkList(errors, raw, "verdicts", (x) => (isObject(x) && isNonEmptyString(x.id) && oneOf(x.verdict, VERDICTS) ? null : `needs id and verdict (${VERDICTS.join("|")})`));
      break;
    case "implementer":
      checkList(errors, raw, "files_changed", strings);
      checkList(errors, raw, "todos_done", strings);
      checkList(errors, raw, "resolutions", resolution);
      if (raw.decision === "needs_context") {
        const cr = raw.context_request;
        if (!isObject(cr) || !isNonEmptyString(cr.question)) errors.push('needs_context requires context_request {"question", "reason"}');
      }
      break;
    case "tester":
      checkList(errors, raw, "tests_written", strings);
      checkList(errors, raw, "failures", (x) => (isObject(x) && isNonEmptyString(x.id) && isNonEmptyString(x.summary) ? null : "needs id and summary"));
      checkList(errors, raw, "manual_gate_reports", gateReport);
      break;
    case "reviewer":
      checkList(errors, raw, "findings", finding);
      checkList(errors, raw, "manual_gate_reports", gateReport);
      if (raw.decision === "changes_requested" && (!Array.isArray(raw.findings) || raw.findings.length === 0)) errors.push("changes_requested needs a non-empty findings list");
      break;
    case "worker":
      checkList(errors, raw, "evidence", (x) => (isObject(x) && isNonEmptyString(x.path) && typeof x.note === "string" ? null : "needs path and note"));
      break;
    default: {
      const never: never = expectedRole;
      throw new Error(`unhandled role ${String(never)}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, result: raw as unknown as RoleResult };
}
