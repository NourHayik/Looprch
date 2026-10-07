import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot, PROTOCOL, READ_ONLY_ROLES, type Role } from "./constants.js";
import { writeFileAtomic } from "./fsx.js";
import { projectPaths } from "./paths.js";
import { DECISIONS } from "./results.js";
import type { Delta } from "./state.js";

export type Task =
  | "planning"
  | "synthesis"
  | "revise"
  | "context_answer"
  | "debate"
  | "design_review"
  | "implementation"
  | "repair"
  | "handover"
  | "testing"
  | "review"
  | "adhoc_review"
  | "worker";

export interface BriefInput {
  root: string;
  runId: string;
  role: Role;
  task: Task;
  stage: string;
  phase: string;
  phaseTitle: string;
  phaseBase: string | null;
  packet: { path: string; bytes: number } | null;
  phaseSource: string | null;
  inputs: { path: string; why: string }[];
  delta: Delta | null;
  userNote: string | null;
  resume: boolean;
  question?: string;
  gateIds: string[];
  /** Task review only: round number, review limit, reviewed tree, tree of the previous review, time budget. */
  reviewRound?: { n: number; of: number; tree: string | null; prevTree: string | null; timeout: string };
}

const ROLE_FILE: Record<Role, string> = {
  planner: "planner.md",
  plan_debater: "plan-debater.md",
  implementer: "implementer.md",
  tester: "tester.md",
  reviewer: "reviewer.md",
  worker: "worker.md",
};

const TASK_DECISIONS: Record<Task, string[]> = {
  planning: ["plan_ready", "needs_expansion"],
  synthesis: ["plan_final", "needs_expansion"],
  revise: ["plan_final"],
  context_answer: ["context_answer"],
  debate: ["findings", "no_findings", "needs_expansion"],
  design_review: ["findings", "no_findings"],
  implementation: ["implemented", "needs_context"],
  repair: ["implemented", "needs_context"],
  handover: ["handover_ready"],
  testing: ["pass", "fail"],
  review: ["approve", "changes_requested"],
  adhoc_review: ["approve", "changes_requested"],
  worker: ["answered"],
};

const CONTRACT_FIELD =
  '"contract": {"obligations": [{"id":"O-1","requirements":["R-001.01"],"kind":"behavior|invariant|boundary|interface|data|failure|production|procedure","statement":"the rule, decidable by a test","enforcement":"the single code path or structural constraint that enforces it","verify":"what the Tester must prove, with negative cases and variants","gates":["<gate id>"],"covers":["P-000/X-1 (incoming deferrals only)"]}], "deferrals": [{"id":"X-1","requirements":["…"],"what":"…","to_phase":"P-00N","interim":"fail-closed behavior in this phase"}], "work_packages": [{"id":"WP-1","title":"…","depends_on":[],"obligations":["O-1"],"files":[{"path":"app/…","action":"create|modify|delete","content":"what the file contains afterwards: classes, functions with signatures, keys, columns"}],"steps":["one concrete instruction per entry, in order"],"done_when":["a command or observation with its expected result"]}]}';
const AMENDMENT_FIELD =
  '"contract_amendment": {"obligations": [ {…same shape as a contract obligation, plus "resolves":["R-4"]} ], "deferrals": [ {… plus "resolves"} ], "work_packages": [ {…same shape as a work package; during implementation, every new obligation needs one} ], "retire": ["O-7"]}; for a repair design also "repair_packages": [{"id":"RP-1","title":"…","findings":["R-1"],"depends_on":[],"files":[{"path":"…","action":"create|modify|delete","content":"…"}],"steps":["…"],"done_when":["…"]}]';

function fields(role: Role, task: Task): string {
  switch (role) {
    case "planner":
      if (task === "context_answer") return `${AMENDMENT_FIELD} (a repair design needs repair_packages, and an amendment for the findings the Delta names; both are optional for a context answer)`;
      return `${CONTRACT_FIELD}${task === "synthesis" ? '; "debate_dispositions": [{"id":"D-1","decision":"accept|reject","reason":"…","refs":["O-3"]}] (one per Plan Debate finding)' : ""}; with needs_expansion: "expansion_requests": [{"kind":"document|phase","id":"…","question":"…","reason":"…"}]`;
    case "plan_debater":
      return '"findings": [{"id":"D-1","severity":"low|medium|high|critical","summary":"…","section":"…","refs":["O-2"]}]';
    case "implementer":
      return '"files_changed": ["…"]; "work_package": "WP-1" (the package the Delta assigns, when it assigns one); after review findings: "resolutions": [{"id":"R-1","status":"fixed|not_fixed|needs_design","note":"what changed or why not","files":["paths your repair changed (required for fixed)"]}] (one per finding the Delta assigns to you); with needs_context: "context_request": {"question":"…","reason":"…"}; with handover_ready: "modified_files":[], "new_files":[], "deleted_files":[], "renamed":[{"from":"…","to":"…"}], "verification_ids":["P-001-g-1"], "limitations":[]';
    case "tester":
      return '"tests_written": ["…"], "verifications": [{"id":"O-1 or R-1","status":"verified|failed|inspected","tests":["testcase name as in the JUnit report, or path::name"],"checks":[{"n":1,"tests":["…"]}] (review findings with Check lines: every check),"variants":["…"],"note":"…"}], "failures": [{"id":"T-1","gate_id":"…","summary":"…"}], "manual_gate_reports": [{"gate_id":"…","path":".looprch/reports/…"}]';
    case "reviewer":
      return '"findings": [{"id":"R-1","severity":"high","summary":"the broken rule","files":["…"],"fix":"the condition the repair must meet","checks":["one concrete, testable acceptance check per line (required for high and critical)"],"owner":"implementer|tester","cause":"implementation|plan|requirement|cross_phase|test","obligations":["O-3"],"related":"R-2 (optional)","origin":"unfixed|regression|missed (re-reviews only)"}], "contract_review": [{"id":"O-1","status":"met|not_met"}] (first review: every obligation and deferral), "prior": [{"id":"R-1","status":"fixed|unfixed","failed_checks":[2]}] (re-reviews: every earlier finding in the Delta), "manual_gate_reports": [{"gate_id":"…","path":".looprch/reports/…"}]';
    case "worker":
      return '"evidence": [{"path":"…","lines":"10-20","note":"…"}]';
    default: {
      const never: never = role;
      throw new Error(`unhandled role ${String(never)}`);
    }
  }
}

export function roleText(role: Role, task: Task): string {
  const text = readFileSync(join(packageRoot(), "assets", "roles", ROLE_FILE[role]), "utf8");
  const parts = text.split(/^### Task: /m);
  const general = parts[0]!.trim();
  const section = parts.slice(1).find((p) => p.startsWith(`${task}\n`));
  return section ? `${general}\n\n### Task: ${section.trim()}` : general;
}

function taskText(input: BriefInput): string {
  const lines: string[] = [];
  switch (input.task) {
    case "planning":
      lines.push(`Write the implementation plan for ${input.phase}.`);
      break;
    case "synthesis":
      lines.push("Synthesize the final plan from your plan and the single Plan Debate pass.");
      break;
    case "revise":
      lines.push("Revise the plan as the user asked (see Delta).");
      break;
    case "context_answer":
      lines.push("Answer the context request or write the repair design in the Delta, from approved sources only.");
      break;
    case "debate":
      lines.push("Critically review the plan and its contract once.");
      break;
    case "design_review":
      lines.push("Challenge the Planner's repair design and its contract amendment once (see Delta). Do not re-review the code.");
      break;
    case "implementation":
      lines.push("Implement the approved plan.");
      break;
    case "repair":
      lines.push("Repair the problems listed in the Delta, then stop.");
      break;
    case "handover":
      lines.push(`Write the final handover. Phase base commit: \`${input.phaseBase ?? "unknown"}\`. Compare with \`git diff --name-status ${input.phaseBase ?? "<base>"}\` plus untracked files.`);
      break;
    case "testing":
      lines.push(`Write or update the tests for the declared gates: ${input.gateIds.join(", ") || "(none)"}. Looprch reruns every gate after you finish.`);
      break;
    case "review": {
      const base = input.phaseBase ?? "<phase_base>";
      lines.push(`Review the implementation of ${input.phase}: actual code, the phase diff, the test report and gates.json.`);
      const r = input.reviewRound;
      if (r) {
        const tree = r.tree ?? "<tree>";
        lines.push(
          `Review round ${r.n} of ${r.of}. Time budget: up to ${r.timeout}. Use the time a complete review needs; do not stop early.`,
          "",
          `- Whole phase: \`git diff --stat ${base} ${tree}\`, one file: \`git diff ${base} ${tree} -- <path>\`. \`${tree}\` is the tree the gates ran on, including uncommitted and new files.`,
        );
        if (r.n > 1 && r.prevTree) lines.push(`- Repair since your last review: \`git diff --stat ${r.prevTree} ${tree}\`.`);
        lines.push("");
        if (r.n === 1) lines.push("This is the first review: follow the first-review procedure and checklist, give `contract_review` for every obligation and deferral in contract.json, and report every finding in this one pass.");
        else lines.push("This is a re-review: follow the re-review rules. Give `prior` (fixed or unfixed) for every finding in the Delta against its unchanged Fix, check the repair diff for regressions, and report anything the earlier review missed.");
        if (r.n >= r.of)
          lines.push(
            "This is the final review. Still put every remaining issue in `findings`. Request changes only for high or critical defects; with only medium or low findings, approve: Looprch records them as open review notes in the handover. If you request changes, the user decides how to continue.",
          );
      } else lines.push(`Phase diff: \`git diff --stat ${base}\` plus untracked files (\`git status --short\`).`);
      break;
    }
    case "adhoc_review":
      lines.push(`Independent review of ${input.phase} requested by the user. Diff source is listed in the inputs.`);
      break;
    case "worker":
      lines.push(`Question: ${input.question ?? "(none)"}`);
      break;
    default: {
      const never: never = input.task;
      throw new Error(`unhandled task ${String(never)}`);
    }
  }
  return lines.join("\n");
}

function deltaText(d: Delta | null, note: string | null): string {
  if (!d && !note) return "";
  const lines = ["", "## Delta", ""];
  if (d) {
    lines.push(d.text);
    for (const f of d.findings ?? []) {
      const tags = [f.severity, f.owner ? `owner ${f.owner}` : null, f.cause ? `cause ${f.cause}` : null, f.origin, f.related ? `related ${f.related}` : null].filter(Boolean).join(", ");
      lines.push(`- ${f.id}${tags ? ` [${tags}]` : ""}${f.gate_id ? ` (${f.gate_id})` : ""}: ${f.summary}${f.files?.length ? ` — ${f.files.join(", ")}` : ""}`);
      if (f.obligations?.length) lines.push(`  Contract: ${f.obligations.join(", ")}`);
      if (f.fix) lines.push(`  Fix: ${f.fix}`);
      (f.checks ?? []).forEach((c, i) => lines.push(`  Check ${i + 1}: ${c}`));
    }
    for (const p of d.paths ?? []) lines.push(`- read: \`${p}\``);
  }
  if (note) lines.push("", `User note: ${note}`);
  lines.push("");
  return lines.join("\n");
}

function outputContract(role: Role, task: Task): string {
  const decisions = TASK_DECISIONS[task].filter((d) => (DECISIONS[role] as readonly string[]).includes(d));
  return [
    "Write your report in Markdown (it is saved as the stage artifact). Then end your final message with exactly one fenced block:",
    "",
    "```looprch-result",
    `{"role":"${role}","decision":"${decisions[0]}", …}`,
    "```",
    "",
    `- decision: one of ${decisions.map((d) => `\`${d}\``).join(", ")}`,
    `- fields: ${fields(role, task)}`,
    "- The block must be valid JSON. Nothing may follow it.",
  ].join("\n");
}

export function assembleBrief(input: BriefInput): string {
  const tpl = readFileSync(join(packageRoot(), "assets", "templates", "brief.md"), "utf8");
  const inputs: string[] = [];
  let n = 1;
  if (input.packet) inputs.push(`${n++}. \`${input.packet.path}\` — exact-source SEV3 packet (${input.packet.bytes} bytes). Read all of it.`);
  else if (input.phaseSource) inputs.push(`${n++}. \`${input.phaseSource}\` — current phase source.`);
  const rules = projectPaths(input.root).userRules;
  if (existsSync(rules)) inputs.push(`${n++}. \`.looprch/user-rules.md\` — project rules every role follows.`);
  for (const i of input.inputs) inputs.push(`${n++}. \`${i.path}\` — ${i.why}`);
  const readOnly = READ_ONLY_ROLES.includes(input.role);
  const writeRule = readOnly
    ? "You are read-only: do not create, edit or delete any file. Looprch checks git status before and after."
    : input.role === "implementer"
      ? "Change application code only; never write or edit tests."
      : input.role === "tester"
        ? "Change test code (and gate evidence) only; never edit application code."
        : "Do not edit files.";
  const vars: Record<string, string> = {
    role_title: input.role.replace("_", " "),
    role: input.role,
    phase: input.phase,
    phase_title: input.phaseTitle,
    run_id: input.runId,
    protocol: String(PROTOCOL),
    stage: input.stage,
    task: input.task,
    phase_base: input.phaseBase ?? "none",
    role_text: roleText(input.role, input.task),
    root: input.root,
    write_rule: writeRule,
    session_note: !input.resume
      ? ""
      : input.role === "reviewer" || input.role === "tester"
        ? "- You are continuing an earlier session for this phase. The code changed since your last run: inspect the current files and the diff, not your memory."
        : "- You are continuing an earlier session for this phase; re-read inputs only where the Delta requires it.",
    inputs: inputs.join("\n") || "(none)",
    task_text: taskText(input),
    delta: deltaText(input.delta, input.userNote),
    output_contract: outputContract(input.role, input.task),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

export function writeBrief(root: string, runId: string, text: string): string {
  const rel = `.looprch/runs/${runId}/brief.md`;
  writeFileAtomic(join(root, rel), text);
  return rel;
}
