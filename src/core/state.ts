import { existsSync } from "node:fs";
import { PROTOCOL, STATE_SCHEMA, VERSION } from "./constants.js";
import type { AgentId, Assignment, Mode } from "./config.js";
import { readJson, writeJsonAtomic } from "./fsx.js";
import { migrate, type Migration } from "./migrations.js";
import { projectPaths } from "./paths.js";

export const STAGES = [
  "preflight",
  "planning",
  "debating",
  "synthesizing",
  "plan_approval",
  "implementing",
  "testing",
  "gating",
  "reviewing",
  "repairing",
  "handover",
  "closing",
] as const;
export type Stage = (typeof STAGES)[number];

export const CLOSE_STEPS = ["ticks", "merge_approval", "commit", "merge", "tag"] as const;
export type CloseStep = (typeof CLOSE_STEPS)[number];

export type Scope = "phase" | "auto" | "finish";

export const QUESTION_KINDS = [
  "commit_baseline",
  "ack_gates",
  "approve_plan",
  "approve_merge",
  "context_over_budget",
  "host_conflict",
  "rate_limit_long",
  "final_review",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface Question {
  id: string;
  kind: QuestionKind;
  question: string;
  options: { id: string; label: string }[];
  context: Record<string, unknown>;
}

export interface BlockedFlag {
  code: string;
  reason: string;
  details: unknown;
  hint: string;
  at: string;
}

export const FINDING_OWNERS = ["implementer", "tester"] as const;
export type FindingOwner = (typeof FINDING_OWNERS)[number];
export const FINDING_ORIGINS = ["unfixed", "regression", "missed"] as const;
export type FindingOrigin = (typeof FINDING_ORIGINS)[number];

export interface Finding {
  id: string;
  severity?: string;
  summary: string;
  files?: string[];
  gate_id?: string;
  /** Review findings: the acceptance condition of the repair. */
  fix?: string;
  owner?: FindingOwner;
  /** Re-review findings only. */
  origin?: FindingOrigin;
}

/** Instructions carried into the next brief for a role (repair findings, re-ask, user note). */
export interface Delta {
  kind: "reask" | "repair" | "rereview" | "unreviewed" | "notes" | "expansion" | "context_answer" | "revise" | "retry" | "switch";
  text: string;
  findings?: Finding[];
  paths?: string[];
}

export interface SessionEntry {
  session_id: string | null;
  mode: Mode;
  resumable: boolean;
  created_at: string;
  last_used: string;
  runs: string[];
}

export interface Current {
  phase: string;
  title: string;
  stage: Stage;
  round: number;
  close_step: CloseStep | null;
  phase_base: string | null;
  branch: string | null;
  last_commit: string | null;
  active_run: string | null;
  stage_entered_at: string;
  tester_verdict: "pass" | "fail" | null;
  tester_failures: Finding[];
  review_findings: Finding[];
  repair_source: "test" | "review" | null;
  /** Reviews in this phase that requested changes; absent in older state files. */
  review_changes?: number;
  /** Repairs caused by failing tests or gates (bounded by limits.repair_rounds); absent in older state files. */
  test_repairs?: number;
  /** Reviews the user allowed beyond limits.review_rounds (final_review answers). */
  extra_reviews?: number;
  /** The final allowed review requested changes; the user decides how to continue. */
  final_review_pending?: boolean;
  /** Tree the last review that requested changes looked at (re-reviews diff against it). */
  reviewed_tree?: string | null;
  /** final.md of the Implementer repair runs since the last review. */
  repair_reports?: string[];
  /** Findings of an approving review (notes), listed in the handover. */
  review_notes?: Finding[];
  expansion_round: number;
  reask_count: number;
  extra_rounds: number;
  context_request: { question: string; reason: string; documents: string[]; phases: string[] } | null;
  addenda: string[];
  deltas: Partial<Record<string, Delta>>;
  /** Fallback index per role for this phase (0 = primary assignment). */
  assignment_index: Partial<Record<string, number>>;
  /** Agent last used per role in this phase, to detect agent switches. */
  last_agent: Partial<Record<string, AgentId>>;
  switch_checkpointed: Partial<Record<string, string>>;
  context_ok: string[];
  manual_reports: Record<string, string>;
  snapshots: { gates: string | null; review: string | null; handover: string | null };
  run_seq: Partial<Record<string, number>>;
  /** Failed attempts per role since its last accepted result. */
  attempts: Partial<Record<string, number>>;
  user_note: string | null;
}

export interface PhaseRecord {
  status: "in_progress" | "closed";
  started_at: string;
  closed_at: string | null;
  merge_commit: string | null;
  tag: string | null;
  rounds_used: number;
  implementers: { agent: AgentId; model: string; runs: string[] }[];
}

export interface AssignmentChange {
  phase: string;
  role: string;
  from: Assignment | null;
  to: Assignment;
  reason: "config" | "quota_fallback" | "rate_limit_fallback" | "run_failed_fallback" | "unavailable_fallback" | "user_choice";
  run_id: string | null;
  at: string;
}

export interface State {
  schema_version: number;
  protocol: number;
  core_version_at_phase_start: string | null;
  scope: Scope;
  spec: {
    package_fingerprint: string | null;
    source_fingerprint: string | null;
    manifest_sha256: string | null;
    toolkit_version: string | null;
    phases_total: number;
    verified_at: string | null;
  };
  git: { base_branch: string | null; baseline_commit: string | null };
  current: Current | null;
  flags: {
    pause_requested: boolean;
    paused: { reason: string; at: string } | null;
    waiting: { until: string; reason: string; role: string | null; agent: string | null } | null;
    blocked: BlockedFlag | null;
  };
  pending_question: Question | null;
  answers: Record<string, string>;
  pending_checkpoint: { label: string } | null;
  runs_index: Record<string, { role: string; status: string; attempt: number; side: boolean }>;
  sessions: Record<string, SessionEntry>;
  assignments_history: AssignmentChange[];
  quota: {
    exhausted: Record<string, { reset: string | null; source: "quotalens" | "rate_limit"; since: string }>;
    rate_limit_wait_started: string | null;
  };
  phases: Record<string, PhaseRecord>;
  project: { status: "in_progress" | "done"; finished_at: string | null };
}

export const STATE_MIGRATIONS: Migration[] = [];

export function initialState(): State {
  return {
    schema_version: STATE_SCHEMA,
    protocol: PROTOCOL,
    core_version_at_phase_start: null,
    scope: "phase",
    spec: { package_fingerprint: null, source_fingerprint: null, manifest_sha256: null, toolkit_version: null, phases_total: 0, verified_at: null },
    git: { base_branch: null, baseline_commit: null },
    current: null,
    flags: { pause_requested: false, paused: null, waiting: null, blocked: null },
    pending_question: null,
    answers: {},
    pending_checkpoint: null,
    runs_index: {},
    sessions: {},
    assignments_history: [],
    quota: { exhausted: {}, rate_limit_wait_started: null },
    phases: {},
    project: { status: "in_progress", finished_at: null },
  };
}

export function newCurrent(phase: string, title: string, at: string): Current {
  return {
    phase,
    title,
    stage: "preflight",
    round: 0,
    close_step: null,
    phase_base: null,
    branch: null,
    last_commit: null,
    active_run: null,
    stage_entered_at: at,
    tester_verdict: null,
    tester_failures: [],
    review_findings: [],
    repair_source: null,
    review_changes: 0,
    test_repairs: 0,
    extra_reviews: 0,
    final_review_pending: false,
    reviewed_tree: null,
    repair_reports: [],
    review_notes: [],
    expansion_round: 0,
    reask_count: 0,
    extra_rounds: 0,
    context_request: null,
    addenda: [],
    deltas: {},
    assignment_index: {},
    last_agent: {},
    switch_checkpointed: {},
    context_ok: [],
    manual_reports: {},
    snapshots: { gates: null, review: null, handover: null },
    run_seq: {},
    attempts: {},
    user_note: null,
  };
}

export function loadState(root: string): State {
  const paths = projectPaths(root);
  if (!existsSync(paths.state)) return initialState();
  const raw = readJson<Record<string, unknown>>(paths.state);
  const migrated = migrate(raw, "state", STATE_SCHEMA, STATE_MIGRATIONS, paths.backups, paths.state) as unknown as State;
  const base = initialState();
  return {
    ...base,
    ...migrated,
    flags: { ...base.flags, ...migrated.flags },
    quota: { ...base.quota, ...migrated.quota },
    answers: migrated.answers ?? {},
  };
}

export function saveState(root: string, state: State): void {
  writeJsonAtomic(projectPaths(root).state, state);
}

export function markPhaseStart(state: State): void {
  state.protocol = PROTOCOL;
  state.core_version_at_phase_start = VERSION;
}
