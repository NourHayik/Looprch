import type { AgentId, Mode } from "./config.js";
import type { Role } from "./constants.js";
import type { ModeReason } from "./mode.js";
import type { QuestionKind } from "./state.js";

interface Base {
  protocol: number;
  phase: string | null;
  stage: string | null;
  round: number;
  summary: string;
  command?: string[];
}

export interface RunRoleAction extends Base {
  action: "run_role";
  run_id: string;
  role: Role;
  task: string;
  mode: Mode;
  mode_reason: ModeReason;
  agent: AgentId;
  model: string;
  effort: string | null;
  brief: string;
  packet: string | null;
  read_only: boolean;
  session: { id: string | null; resume: boolean };
  attempt: number;
  subagent?: string;
  spawn_hint?: string;
  record_command?: string[];
}

export type Action =
  | RunRoleAction
  | (Base & { action: "await_run"; run_id: string; poll_after_seconds: number })
  | (Base & { action: "run_gates" })
  | (Base & { action: "checkpoint"; label: string })
  | (Base & { action: "wait"; until: string; reason: string })
  | (Base & { action: "ask_user"; question_id: string; kind: QuestionKind; question: string; options: { id: string; label: string }[]; command_template: string[] })
  | (Base & { action: "paused"; reason: string })
  | (Base & { action: "blocked"; code: string; reason: string; details: unknown; hint: string; durable: boolean })
  | (Base & { action: "phase_closed"; tag: string; merge_commit: string })
  | (Base & { action: "stop_before_closure"; closure_phase: string | null })
  | (Base & { action: "project_done"; report: string });

export type ActionName = Action["action"];

/** Whether the Lead's loop stops on this action (scope rules for phase_closed live in the skills). */
export function stopsLoop(a: Action): boolean {
  switch (a.action) {
    case "run_role":
    case "await_run":
    case "run_gates":
    case "checkpoint":
    case "wait":
    case "ask_user":
    case "phase_closed":
      return false;
    case "paused":
    case "blocked":
    case "stop_before_closure":
    case "project_done":
      return true;
    default: {
      const never: never = a;
      throw new Error(`unhandled action ${JSON.stringify(never)}`);
    }
  }
}

export const ACTION_NAMES: ActionName[] = ["run_role", "await_run", "run_gates", "checkpoint", "wait", "ask_user", "paused", "blocked", "phase_closed", "stop_before_closure", "project_done"];

export const BLOCK_CODES = [
  "spec_changed",
  "toolkit_untrusted",
  "repair_limit",
  "merge_conflict",
  "head_mismatch",
  "dirty_tree",
  "no_git_identity",
  "hook_failed",
  "relay_missing",
  "cli_missing",
  "delegate_unsupported",
  "host_not_enabled",
  "config_invalid",
  "result_invalid",
  "handover_mismatch",
  "readonly_violation",
  "run_failed",
  "usage_error",
  "expansion_limit",
  "phases_remaining",
  "not_initialized",
] as const;
