import { join } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "./fsx.js";
import { projectPaths } from "./paths.js";
import type { Disposition } from "./plan.js";

/**
 * The debate ledger of one phase plan (`debate.json`): every finding the Plan Debater raised, how
 * the Planner answered it and how the Debater judged that answer.
 */

export const VERDICTS = ["resolved", "conceded", "upheld"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type EntryStatus = "open" | "resolved" | "conceded" | "contested" | "user_decided";

export interface DebateEntry {
  id: string;
  source: "debater";
  severity: string;
  summary: string;
  section?: string;
  suggestion?: string;
  /** Debater pass that raised it. */
  round: number;
  status: EntryStatus;
  disposition?: Disposition & { round: number };
  verdicts: { round: number; verdict: Verdict; note?: string }[];
  /** Why it was closed without the Debater's agreement (limits, user decisions, low severity). */
  closed_note?: string;
}

export interface RoundYield {
  round: number;
  raised: number;
  accepted: number;
  rejected: number;
  resolved: number;
  conceded: number;
  upheld: number;
  /** Plan revisions written in answer to this round. */
  contract_changes: number;
}

export interface DebateLedger {
  schema_version: 1;
  phase: string;
  /** Plan Debater passes so far (debate plus rebuttals). */
  rounds: number;
  entries: DebateEntry[];
  yield: RoundYield[];
}

export function ledgerPath(root: string, phase: string): string {
  return join(projectPaths(root).phase(phase), "debate.json");
}

export function newLedger(phase: string): DebateLedger {
  return { schema_version: 1, phase, rounds: 0, entries: [], yield: [] };
}

export function loadLedger(root: string, phase: string): DebateLedger {
  return readJsonIfExists<DebateLedger>(ledgerPath(root, phase)) ?? newLedger(phase);
}

export function saveLedger(root: string, l: DebateLedger): void {
  writeJsonAtomic(ledgerPath(root, l.phase), l);
}

export function openEntries(l: DebateLedger): DebateEntry[] {
  return l.entries.filter((e) => e.status === "open");
}

export const SERIOUS = new Set(["high", "critical"]);

function yieldOf(l: DebateLedger, round: number): RoundYield {
  let y = l.yield.find((x) => x.round === round);
  if (!y) {
    y = { round, raised: 0, accepted: 0, rejected: 0, resolved: 0, conceded: 0, upheld: 0, contract_changes: 0 };
    l.yield.push(y);
  }
  return y;
}

/** Add new items; an id already in the ledger gets a suffix so earlier items are never overwritten. */
export function addEntries(l: DebateLedger, list: Omit<DebateEntry, "status" | "verdicts">[]): DebateEntry[] {
  const out: DebateEntry[] = [];
  for (const raw of list) {
    let id = raw.id;
    for (let n = 2; l.entries.some((e) => e.id === id); n++) id = `${raw.id}.${n}`;
    const entry: DebateEntry = { ...raw, id, status: "open", verdicts: [] };
    l.entries.push(entry);
    out.push(entry);
  }
  if (out.length) yieldOf(l, l.rounds).raised += out.length;
  return out;
}

/** Record the Planner's answers to the open items and its plan revision. */
export function applyDispositions(l: DebateLedger, list: Disposition[]): void {
  const y = yieldOf(l, l.rounds);
  y.contract_changes++;
  for (const d of list) {
    const e = l.entries.find((x) => x.id === d.id && x.status === "open");
    if (!e) continue;
    e.disposition = { ...d, round: l.rounds };
    if (d.decision === "accept") y.accepted++;
    else y.rejected++;
  }
}

/** Record the Debater's verdicts on the Planner's answers; resolved and conceded items close. */
export function applyVerdicts(l: DebateLedger, list: { id: string; verdict: Verdict; note?: string }[]): void {
  const y = yieldOf(l, l.rounds);
  for (const v of list) {
    const e = l.entries.find((x) => x.id === v.id && x.status === "open");
    if (!e) continue;
    e.verdicts.push({ round: l.rounds, verdict: v.verdict, ...(v.note ? { note: v.note } : {}) });
    y[v.verdict]++;
    if (v.verdict !== "upheld") e.status = v.verdict;
  }
}

/** Close items without a Debater verdict (agreement, low severity, limits, user decisions). */
export function closeEntries(entries: DebateEntry[], status: Exclude<EntryStatus, "open">, note: string): void {
  for (const e of entries) {
    e.status = status;
    e.closed_note = note;
  }
}

/** One line per item for briefs and questions. */
export function entryLine(e: DebateEntry): string {
  const last = e.verdicts.at(-1);
  const tags = [e.severity, e.disposition ? `planner ${e.disposition.decision}` : null, last ? `debater ${last.verdict}` : null].filter(Boolean).join(", ");
  return `${e.id} [${tags}]: ${e.summary}`;
}

/** Totals for the journal, `status --json` and the handover. */
export function ledgerSummary(l: DebateLedger): Record<string, number> {
  const count = (s: EntryStatus) => l.entries.filter((e) => e.status === s).length;
  return {
    rounds: l.rounds,
    readbacks: 0,
    items: l.entries.length,
    resolved: count("resolved"),
    conceded: count("conceded"),
    contested: count("contested"),
    user_decided: count("user_decided"),
    open: count("open"),
    contract_changes: l.yield.reduce((s, y) => s + y.contract_changes, 0),
  };
}
