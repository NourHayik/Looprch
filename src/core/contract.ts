import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fsx.js";
import { projectPaths } from "./paths.js";
import { isNonEmptyString, isObject, isStringArray, oneOf } from "./validate.js";
import type { State } from "./state.js";
import type { Manifest, PhaseDef } from "../sev3/manifest.js";

export const OBLIGATION_KINDS = ["behavior", "invariant", "boundary", "interface", "data", "failure", "production", "procedure"] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export interface Obligation {
  id: string;
  requirements: string[];
  kind: ObligationKind;
  /** The rule or behavior, stated so a test can decide it. */
  statement: string;
  /** The single code path (or structural constraint) that enforces it. */
  enforcement: string;
  /** What the Tester must prove, including negative cases and variants. */
  verify: string;
  gates: string[];
  /** Incoming deferrals (`P-NNN/X-n`) this obligation takes over. */
  covers?: string[];
  /** Review findings this obligation answers (contract amendments). */
  resolves?: string[];
}

export interface Deferral {
  id: string;
  requirements: string[];
  what: string;
  to_phase: string;
  /** Fail-closed behavior in this phase until `to_phase` delivers. */
  interim: string;
  covers?: string[];
  resolves?: string[];
}

export const WORK_FILE_ACTIONS = ["create", "modify", "delete"] as const;

export interface WorkFile {
  path: string;
  action: (typeof WORK_FILE_ACTIONS)[number];
  /** What the file contains after this package: classes, functions with signatures, keys, columns. */
  content: string;
}

/**
 * A unit of literal work for the Implementer: a work package of the plan (with the obligations it
 * implements) or a repair package of a review round (with the findings it repairs).
 */
export interface WorkItem {
  id: string;
  title: string;
  depends_on?: string[];
  obligations?: string[];
  findings?: string[];
  files: WorkFile[];
  /** Ordered, concrete instructions; each one leaves no design decision open. */
  steps: string[];
  /** Commands or observations the Implementer runs to check its own work, with the expected result. */
  done_when: string[];
}

/** Bounds that keep one package small enough for one focused run of a cheaper model. */
export const WORK_LIMITS = { steps: 25, files: 25, findings: 5 } as const;

export interface ContractBody {
  obligations: Obligation[];
  deferrals: Deferral[];
  /** Ordered work packages the Implementer executes one run at a time (protocol 3). */
  work_packages?: WorkItem[];
}

export interface Contract extends ContractBody {
  schema_version: 1;
  phase: string;
  revision: number;
}

export interface Amendment {
  obligations?: Obligation[];
  deferrals?: Deferral[];
  work_packages?: WorkItem[];
  retire?: string[];
}

export interface IncomingDeferral extends Deferral {
  from_phase: string;
  /** `P-NNN/X-n`, the id an obligation or deferral lists in `covers`. */
  ref: string;
}

export interface ContractContext {
  phase: PhaseDef;
  manifest: Manifest;
  incoming: IncomingDeferral[];
}

const MAX_LISTED = 20;

function listed(ids: string[]): string {
  return ids.length > MAX_LISTED ? `${ids.slice(0, MAX_LISTED).join(", ")} and ${ids.length - MAX_LISTED} more` : ids.join(", ");
}

const optionalIds = (x: Record<string, unknown>, key: string): string | null => (x[key] === undefined || isStringArray(x[key]) ? null : `${key} must be a list of ids`);

function obligationShape(x: unknown): string | null {
  if (!isObject(x)) return "must be an object";
  if (!isNonEmptyString(x.id)) return "id is required";
  if (!isStringArray(x.requirements)) return `${x.id}: requirements must be a list of requirement ids`;
  if (!oneOf(x.kind, OBLIGATION_KINDS)) return `${x.id}: kind must be one of ${OBLIGATION_KINDS.join(", ")}`;
  for (const k of ["statement", "enforcement", "verify"]) if (!isNonEmptyString(x[k])) return `${x.id}: ${k} is required`;
  if (!isStringArray(x.gates)) return `${x.id}: gates must be a list of gate ids (use [] for none)`;
  return optionalIds(x, "covers") ?? optionalIds(x, "resolves");
}

function deferralShape(x: unknown): string | null {
  if (!isObject(x)) return "must be an object";
  if (!isNonEmptyString(x.id)) return "id is required";
  if (!isStringArray(x.requirements)) return `${x.id}: requirements must be a list of requirement ids`;
  for (const k of ["what", "to_phase", "interim"]) if (!isNonEmptyString(x[k])) return `${x.id}: ${k} is required`;
  return optionalIds(x, "covers") ?? optionalIds(x, "resolves");
}

function workFileShape(x: unknown): string | null {
  if (!isObject(x) || !isNonEmptyString(x.path)) return "each file needs a path";
  if (!oneOf(x.action, WORK_FILE_ACTIONS)) return `${x.path}: action must be one of ${WORK_FILE_ACTIONS.join(", ")}`;
  if (x.action !== "delete" && !isNonEmptyString(x.content)) return `${x.path}: content must say what the file contains (classes, functions with signatures, keys, columns)`;
  if (x.content !== undefined && typeof x.content !== "string") return `${x.path}: content must be a string`;
  return null;
}

/** Shape of a work package (`kind` plan) or repair package (`kind` repair). */
export function workItemShape(kind: "plan" | "repair") {
  return (x: unknown): string | null => {
    if (!isObject(x)) return "must be an object";
    if (!isNonEmptyString(x.id)) return "id is required";
    if (!isNonEmptyString(x.title)) return `${x.id}: title is required`;
    if (!Array.isArray(x.files) || !x.files.length) return `${x.id}: files must list every file the package creates, modifies or deletes`;
    for (const f of x.files) {
      const e = workFileShape(f);
      if (e) return `${x.id}: ${e}`;
    }
    if (!isStringArray(x.steps) || !x.steps.length) return `${x.id}: steps must be a non-empty list of concrete instructions`;
    if (!isStringArray(x.done_when) || !x.done_when.length) return `${x.id}: done_when must list the commands or observations that show the package is done`;
    if (x.steps.length > WORK_LIMITS.steps) return `${x.id} has ${x.steps.length} steps (max ${WORK_LIMITS.steps}): split it into smaller packages`;
    if (x.files.length > WORK_LIMITS.files) return `${x.id} touches ${x.files.length} files (max ${WORK_LIMITS.files}): split it into smaller packages`;
    if (kind === "plan" && !isStringArray(x.obligations)) return `${x.id}: obligations must list the contract obligations (or deferral interims) the package implements ([] for scaffolding)`;
    if (kind === "repair") {
      if (!isStringArray(x.findings) || !x.findings.length) return `${x.id}: findings must name the review findings the package repairs`;
      if (x.findings.length > WORK_LIMITS.findings) return `${x.id} repairs ${x.findings.length} findings (max ${WORK_LIMITS.findings}): split it`;
    }
    return optionalIds(x, "depends_on") ?? optionalIds(x, "obligations") ?? optionalIds(x, "findings");
  };
}

function listShape(errors: string[], obj: Record<string, unknown>, key: string, item: (v: unknown) => string | null, required: boolean): void {
  const v = obj[key];
  if (v === undefined && !required) return;
  if (!Array.isArray(v)) {
    errors.push(`${key} must be a list`);
    return;
  }
  v.forEach((x, i) => {
    const e = item(x);
    if (e) errors.push(`${key}[${i}]: ${e}`);
  });
}

/** Shape of the `contract` object of a Planner plan result. */
export function contractShapeErrors(raw: unknown): string[] {
  if (!isObject(raw)) return ['contract is required: {"obligations": [...], "deferrals": [...]}'];
  const errors: string[] = [];
  listShape(errors, raw, "obligations", obligationShape, true);
  listShape(errors, raw, "deferrals", deferralShape, true);
  listShape(errors, raw, "work_packages", workItemShape("plan"), true);
  return errors.map((e) => `contract.${e}`);
}

/** Shape of a `contract_amendment` (context answers and repair designs). */
export function amendmentShapeErrors(raw: unknown): string[] {
  if (!isObject(raw)) return ["contract_amendment must be an object"];
  const errors: string[] = [];
  listShape(errors, raw, "obligations", obligationShape, false);
  listShape(errors, raw, "deferrals", deferralShape, false);
  listShape(errors, raw, "work_packages", workItemShape("plan"), false);
  if (raw.retire !== undefined && !isStringArray(raw.retire)) errors.push("retire must be a list of ids");
  return errors.map((e) => `contract_amendment.${e}`);
}

function knownRequirementIds(m: Manifest): Set<string> {
  const ids = new Set<string>();
  for (const d of m.documents ?? []) for (const id of d.ids ?? []) ids.add(id);
  for (const p of m.phases) for (const id of p.requirements ?? []) ids.add(id);
  return ids;
}

/** Deterministic checks of a contract against the phase: coverage, ids, gates, deferral targets, incoming deferrals. */
export function contractProblems(body: ContractBody, ctx: ContractContext, opts: { amended?: boolean } = {}): string[] {
  const problems: string[] = [];
  const all = [...body.obligations, ...body.deferrals];
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const x of all) (seen.has(x.id) ? dup : seen).add(x.id);
  if (dup.size) problems.push(`duplicate obligation/deferral ids: ${listed([...dup])}`);
  if (ctx.phase.requirements.length && !body.obligations.length) problems.push("the contract has no obligations");
  const known = knownRequirementIds(ctx.manifest);
  const unknown = [...new Set(all.flatMap((x) => x.requirements).filter((r) => !known.has(r)))];
  if (unknown.length) problems.push(`unknown requirement ids (not in phases/manifest.json): ${listed(unknown)}`);
  const covered = new Set(all.flatMap((x) => x.requirements));
  const uncovered = ctx.phase.requirements.filter((r) => !covered.has(r));
  if (uncovered.length) problems.push(`every mapped requirement of ${ctx.phase.id} needs an obligation or a deferral; uncovered: ${listed(uncovered)}`);
  const gateIds = new Set(ctx.phase.gates.map((g) => g.id));
  const badGates = [...new Set(body.obligations.flatMap((o) => o.gates).filter((g) => !gateIds.has(g)))];
  if (badGates.length) problems.push(`unknown gate ids (the phase declares ${[...gateIds].join(", ") || "none"}): ${listed(badGates)}`);
  for (const d of body.deferrals) {
    const target = ctx.manifest.phases.find((p) => p.id === d.to_phase);
    if (!target) problems.push(`${d.id}: to_phase ${d.to_phase} is not a phase in phases/manifest.json`);
    else if (target.number <= ctx.phase.number) problems.push(`${d.id}: to_phase ${d.to_phase} is not later than ${ctx.phase.id}`);
  }
  const covers = new Set(all.flatMap((x) => x.covers ?? []));
  const open = ctx.incoming.filter((d) => !covers.has(d.ref)).map((d) => d.ref);
  if (open.length) problems.push(`deferrals from earlier phases to ${ctx.phase.id} must be covered (list the id in "covers" of an obligation, or defer it again): ${listed(open)}`);
  if (body.work_packages) problems.push(...workPackageProblems(body.work_packages, body.obligations, !opts.amended, body.deferrals));
  return problems;
}

/**
 * Work packages: unique ids, known obligations, an acyclic order and, for a plan (not an
 * amendment, whose new obligations are built by repair packages), every obligation implemented.
 */
export function workPackageProblems(wps: WorkItem[], obligations: Obligation[], complete = true, deferrals: Deferral[] = []): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const dup = wps.filter((w) => (ids.has(w.id) ? true : (ids.add(w.id), false))).map((w) => w.id);
  if (dup.length) problems.push(`duplicate work package ids: ${listed(dup)}`);
  if (complete && obligations.length && !wps.length) problems.push("the contract has no work_packages: break the implementation into ordered packages the Implementer executes one at a time");
  const obIds = new Set([...obligations, ...deferrals].map((o) => o.id));
  const unknown = [...new Set(wps.flatMap((w) => w.obligations ?? []).filter((o) => !obIds.has(o)))];
  if (unknown.length) problems.push(`work packages name unknown obligations or deferrals: ${listed(unknown)}`);
  const implemented = new Set(wps.flatMap((w) => w.obligations ?? []));
  const orphan = obligations.filter((o) => !implemented.has(o.id)).map((o) => o.id);
  if (complete && orphan.length && wps.length) problems.push(`every obligation needs a work package that implements it; none for: ${listed(orphan)}`);
  const badDeps = wps.flatMap((w) => (w.depends_on ?? []).filter((d) => !ids.has(d)).map((d) => `${w.id} -> ${d}`));
  if (badDeps.length) problems.push(`depends_on names unknown work packages: ${listed(badDeps)}`);
  else if (orderWork(wps) === null) problems.push("work package depends_on has a cycle");
  return problems;
}

/** Repair packages of a repair design: every design finding repaired, unique ids, bounded size. */
export function repairPackageProblems(rps: WorkItem[] | undefined, findingIds: string[]): string[] {
  if (!rps?.length) return ['a repair design returns "repair_packages": small, ordered packages with the exact files, steps and done_when checks the Implementer executes literally, each listing the findings it repairs'];
  const problems: string[] = [];
  const allowed = new Set(findingIds);
  const foreign = [...new Set(rps.flatMap((w) => w.findings ?? []).filter((f) => !allowed.has(f)))];
  if (foreign.length) problems.push(`repair packages may only repair this design's findings (${findingIds.join(", ")}); not: ${listed(foreign)}`);
  const ids = new Set<string>();
  const dup = rps.filter((w) => (ids.has(w.id) ? true : (ids.add(w.id), false))).map((w) => w.id);
  if (dup.length) problems.push(`duplicate repair package ids: ${listed(dup)}`);
  const covered = new Set(rps.flatMap((w) => w.findings ?? []));
  const missing = findingIds.filter((f) => !covered.has(f));
  if (missing.length) problems.push(`every finding of the repair design needs a repair package that lists it in "findings"; missing: ${listed(missing)}`);
  const badDeps = rps.flatMap((w) => (w.depends_on ?? []).filter((d) => !ids.has(d)).map((d) => `${w.id} -> ${d}`));
  if (badDeps.length) problems.push(`depends_on names unknown repair packages: ${listed(badDeps)}`);
  else if (orderWork(rps) === null) problems.push("repair package depends_on has a cycle");
  return problems;
}

/** The packages in an order that respects depends_on (stable for independent ones); null on a cycle. */
export function orderWork(items: WorkItem[]): WorkItem[] | null {
  const done = new Set<string>();
  const out: WorkItem[] = [];
  const rest = [...items];
  while (rest.length) {
    const i = rest.findIndex((w) => (w.depends_on ?? []).every((d) => done.has(d) || !items.some((x) => x.id === d)));
    if (i < 0) return null;
    const [w] = rest.splice(i, 1);
    done.add(w!.id);
    out.push(w!);
  }
  return out;
}

export interface Disposition {
  id: string;
  decision: "accept" | "reject";
  reason: string;
  refs?: string[];
}

export function dispositionShape(x: unknown): string | null {
  if (!isObject(x) || !isNonEmptyString(x.id)) return "needs id";
  if (!oneOf(x.decision, ["accept", "reject"] as const)) return `${x.id}: decision must be accept or reject`;
  if (!isNonEmptyString(x.reason)) return `${x.id}: reason is required`;
  if (x.refs !== undefined && !isStringArray(x.refs)) return `${x.id}: refs must be a list of obligation or deferral ids`;
  return null;
}

/** Every debate finding is accepted (with the obligations/deferrals that carry it) or rejected with a reason. */
export function dispositionProblems(list: Disposition[] | undefined, debateIds: string[], body: ContractBody): string[] {
  const got = new Map((list ?? []).map((d) => [d.id, d]));
  const missing = debateIds.filter((id) => !got.has(id));
  const problems: string[] = [];
  if (missing.length) problems.push(`debate_dispositions must list every Plan Debate finding ({"id","decision":"accept|reject","reason","refs"}); missing: ${missing.join(", ")}`);
  const ids = new Set([...body.obligations, ...body.deferrals].map((x) => x.id));
  for (const d of list ?? []) {
    if (d.decision !== "accept") continue;
    const refs = d.refs ?? [];
    if (!refs.length) problems.push(`${d.id} is accepted: refs must name the obligation(s) or deferral(s) that carry it`);
    const bad = refs.filter((r) => !ids.has(r));
    if (bad.length) problems.push(`${d.id}: refs ${bad.join(", ")} are not in the contract`);
  }
  return problems;
}

/** Apply an amendment: retire ids, then replace (same id) or add obligations and deferrals. */
export function amend(c: Contract, a: Amendment): Contract {
  const retire = new Set(a.retire ?? []);
  const merge = <T extends { id: string }>(base: T[], upd: T[] | undefined): T[] => {
    const out = base.filter((x) => !retire.has(x.id));
    for (const u of upd ?? []) {
      const i = out.findIndex((x) => x.id === u.id);
      if (i >= 0) out[i] = u;
      else out.push(u);
    }
    return out;
  };
  const packages = c.work_packages || a.work_packages ? merge(c.work_packages ?? [], a.work_packages).map((w) => ({ ...w, obligations: (w.obligations ?? []).filter((o) => !retire.has(o)) })) : null;
  return {
    ...c,
    revision: c.revision + 1,
    obligations: merge(c.obligations, a.obligations),
    deferrals: merge(c.deferrals, a.deferrals),
    ...(packages ? { work_packages: packages } : {}),
  };
}

/** Findings a repair design must answer that no amended obligation or deferral lists in `resolves`. */
export function unresolvedByAmendment(a: Amendment | undefined, findingIds: string[]): string[] {
  const resolved = new Set([...(a?.obligations ?? []), ...(a?.deferrals ?? [])].flatMap((x) => x.resolves ?? []));
  return findingIds.filter((id) => !resolved.has(id));
}

export function contractIds(c: ContractBody | null): string[] {
  return c ? [...c.obligations, ...c.deferrals].map((x) => x.id) : [];
}

export function contractPath(root: string, phase: string): string {
  return join(projectPaths(root).phase(phase), "contract.json");
}

export function loadContract(root: string, phase: string): Contract | null {
  return readJsonIfExists<Contract>(contractPath(root, phase));
}

/** Write contract.json, keeping the previous version as contract.r<n>.json. */
export function saveContract(root: string, phase: string, c: Contract): string {
  const path = contractPath(root, phase);
  if (existsSync(path)) {
    let n = 0;
    while (existsSync(join(projectPaths(root).phase(phase), `contract.r${n}.json`))) n++;
    copyFileSync(path, join(projectPaths(root).phase(phase), `contract.r${n}.json`));
  }
  writeJsonAtomic(path, c);
  return path;
}

export function newContract(phase: string, body: ContractBody, revision = 1): Contract {
  return { schema_version: 1, phase, revision, obligations: body.obligations, deferrals: body.deferrals, ...(body.work_packages ? { work_packages: body.work_packages } : {}) };
}

/** Deferrals that closed phases made to `phaseId`. */
export function incomingDeferrals(root: string, manifest: Manifest, st: State, phaseId: string): IncomingDeferral[] {
  const out: IncomingDeferral[] = [];
  for (const p of manifest.phases) {
    if (p.id === phaseId || st.phases[p.id]?.status !== "closed") continue;
    const c = loadContract(root, p.id);
    for (const d of c?.deferrals ?? []) if (d.to_phase === phaseId) out.push({ ...d, from_phase: p.id, ref: `${p.id}/${d.id}` });
  }
  return out;
}
