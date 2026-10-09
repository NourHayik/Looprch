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
  | "rebuttal"
  | "implementation"
  | "repair"
  | "handover"
  | "testing"
  | "review"
  | "adhoc_review"
  | "worker";

/** The Implementer the plan is written for: the Planner sizes the sessions to its context. */
export interface ImplementerInfo {
  agent: string;
  model: string;
  context_kb: number | null;
}

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
  /** The run may not change files (the advisory side runs). */
  readOnly?: boolean;
  /** Debate rounds: this pass and the limit. */
  debateRound?: { n: number; of: number };
  /** Planner and Plan Debater runs: the Implementer the plan is for. */
  implementer?: ImplementerInfo | null;
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
  rebuttal: ["agree", "findings"],
  implementation: ["implemented", "needs_context"],
  repair: ["implemented", "needs_context"],
  handover: ["handover_ready"],
  testing: ["pass", "fail"],
  review: ["approve", "changes_requested"],
  adhoc_review: ["approve", "changes_requested"],
  worker: ["answered"],
};

const PLAN_FIELD =
  '"plan": {"todos": [{"id":"T-1","title":"one line: what the todo delivers","section":"1. <plan phase>"}], "sessions": [["T-1","T-2","T-3"]] (Implementer sessions: contiguous groups of todos, one Implementer run each; usually one session with every todo), "requirements": {"R-001.01": ["T-2"]} (each requirement of the phase -> the todos or deferral ids that deliver it), "deferrals": [{"id":"X-1","what":"…","to_phase":"P-00N","interim":"safe behavior in this phase","requirements":["…"]}]}';
const DEBATE_FINDING = '{"id":"D-1","severity":"low|medium|high|critical","summary":"the defect, and how the Implementer would go wrong because of it","section":"the plan section","suggestion":"the change that closes it"}';
const EXPANSION_FIELD = 'with needs_expansion: "expansion_requests": [{"kind":"document|phase","id":"…","question":"…","reason":"…"}]';
const CONTEXT_REQUEST = 'with needs_context (only for a question that blocks the work): "context_request": {"question":"…","reason":"why the plan does not answer it and a wrong guess would break the phase"}';

function fields(role: Role, task: Task): string {
  switch (role) {
    case "planner":
      if (task === "context_answer") return '"new_todos": [{"id":"T-9","title":"…","section":"…"}] (optional: todos your answer adds; they join the Implementer\'s current session)';
      return `${PLAN_FIELD}${task === "synthesis" || task === "revise" ? '; "debate_dispositions": [{"id":"D-1","decision":"accept|reject","note":"what you changed, or why the finding does not hold"}] (one per open debate item in the Delta)' : ""}; ${EXPANSION_FIELD}`;
    case "plan_debater":
      if (task === "rebuttal") return `"verdicts": [{"id":"D-1","verdict":"resolved|conceded|upheld","note":"what you checked; for upheld, what is still missing"}] (one per open item in the Delta), "findings": [${DEBATE_FINDING}] (new defects only)`;
      return `"findings": [${DEBATE_FINDING}]; ${EXPANSION_FIELD}`;
    case "implementer":
      if (task === "handover") return '"limitations": ["…"] (Looprch adds the file lists from git)';
      if (task === "repair") return `"files_changed": ["…"], "resolutions": [{"id":"R-1","status":"fixed|not_fixed","note":"…"}] (optional, one per finding), "notes": ["…"]; ${CONTEXT_REQUEST}`;
      return `"todos_done": ["T-1"] (the todos of your session you finished), "files_changed": ["…"], "notes": ["choices you made where the plan left a small gap"]; ${CONTEXT_REQUEST}`;
    case "tester":
      return '"tests_written": ["…"], "failures": [{"id":"F-1","gate_id":"…","summary":"…","files":["…"]}], "manual_gate_reports": [{"gate_id":"…","path":".looprch/reports/…"}]';
    case "reviewer":
      return '"findings": [{"id":"R-1","severity":"low|medium|high|critical","summary":"the broken rule and where it breaks","files":["…"],"fix":"the condition the repair must meet","owner":"implementer|tester"}], "manual_gate_reports": [{"gate_id":"…","path":".looprch/reports/…"}]';
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

/** The Implementer line of Planner and Plan Debater briefs. */
function implementerLine(info: ImplementerInfo | null | undefined): string {
  if (!info) return "The Implementer is not configured; assume a cheaper model with a context of about 200K tokens.";
  const budget = info.context_kb ? `a context budget of ${info.context_kb} KB (about ${Math.round(info.context_kb / 4)}K tokens)` : "an unknown context budget: assume about 200K tokens";
  return `The Implementer of this phase is ${info.agent}/${info.model}, with ${budget}.`;
}

function taskText(input: BriefInput): string {
  const lines: string[] = [];
  const round = input.debateRound ? ` (debate round ${input.debateRound.n} of ${input.debateRound.of})` : "";
  switch (input.task) {
    case "planning":
      lines.push(`Write the implementation plan for ${input.phase}: plan.md (the guide) and the plan block (todos and Implementer sessions).`, implementerLine(input.implementer));
      break;
    case "synthesis":
      lines.push(`Answer every open debate item in the Delta${round} and write the full revised plan.`, implementerLine(input.implementer));
      break;
    case "rebuttal":
      lines.push(`Judge the Planner's answers to the open debate items${round} against the revised plan, then look for new serious defects in what changed.`, implementerLine(input.implementer));
      break;
    case "revise":
      lines.push("Revise the plan as the user asked (see Delta).", implementerLine(input.implementer));
      break;
    case "context_answer":
      lines.push("Answer the Implementer's question in the Delta from the plan, the packet and the code. Looprch appends your answer to plan.md as an addendum.");
      break;
    case "debate":
      lines.push(`Challenge the plan against the packet${round}. The Planner answers every finding and you judge the answers in the next round.`, implementerLine(input.implementer));
      break;
    case "implementation":
      lines.push("Implement your session's todos (see Delta) in order, following plan.md.");
      break;
    case "repair":
      lines.push("Repair the problems listed in the Delta, then stop.");
      break;
    case "handover":
      lines.push(`Write the final handover. Phase base commit: \`${input.phaseBase ?? "unknown"}\` (\`git diff --stat ${input.phaseBase ?? "<base>"}\` shows the phase's changes).`);
      break;
    case "testing":
      lines.push(`Write or update the tests for the declared gates: ${input.gateIds.join(", ") || "(none)"}. Looprch reruns every gate after you finish.`);
      break;
    case "review": {
      const base = input.phaseBase ?? "<phase_base>";
      lines.push(`Review the implementation of ${input.phase}: the actual code, the phase diff, the test report and gates.json.`);
      const r = input.reviewRound;
      if (r) {
        const tree = r.tree ?? "<tree>";
        lines.push(`Review round ${r.n} of ${r.of}. Time budget: up to ${r.timeout}.`, "", `- Whole phase: \`git diff --stat ${base} ${tree}\`, one file: \`git diff ${base} ${tree} -- <path>\`. \`${tree}\` is the tree the gates ran on, including uncommitted and new files.`);
        if (r.n > 1 && r.prevTree) lines.push(`- Repair since your last review: \`git diff --stat ${r.prevTree} ${tree}\`.`);
        lines.push("");
        if (r.n === 1) lines.push("This is the first review: report every finding in this one pass.");
        else lines.push("This is a re-review: check the earlier findings in the Delta against the current code, check the repair diff for regressions, and report what still holds and anything new.");
        if (r.n >= r.of) lines.push("This is the final review. Request changes only for high or critical defects; with only medium or low findings, approve: Looprch records them as open review notes in the handover.");
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
      const tags = [f.severity, f.owner ? `owner ${f.owner}` : null].filter(Boolean).join(", ");
      lines.push(`- ${f.id}${tags ? ` [${tags}]` : ""}${f.gate_id ? ` (${f.gate_id})` : ""}: ${f.summary}${f.files?.length ? ` — ${f.files.join(", ")}` : ""}`);
      if (f.fix) lines.push(`  Fix: ${f.fix}`);
    }
    for (const p of d.paths ?? []) lines.push(`- read: \`${p}\``);
  }
  if (note) lines.push("", `User note: ${note}`);
  lines.push("");
  return lines.join("\n");
}

/** Tasks whose report is large enough that the Planner writes it to its report file and fixes it in place. */
export const REPORT_FILE_TASKS = new Set<Task>(["planning", "synthesis", "revise", "context_answer"]);

function selfCheck(input: BriefInput): string[] {
  const check = `looprch check ${input.runId} --root ${input.root}`;
  if (input.role === "planner" && REPORT_FILE_TASKS.has(input.task))
    return [
      "",
      `Self-check before you end: write your complete report, the markdown and the looprch-result block, to \`.looprch/runs/${input.runId}/report.md\`, then run \`${check}\`. It checks that Looprch can read the result block. Fix what it lists and run it again until it prints ok. Then end with a short final message; Looprch reads the report file.`,
    ];
  return ["", `Self-check before you end: pipe your looprch-result block into \`${check} --stdin\` and fix what it lists. If you cannot run commands, skip this.`];
}

function outputContract(input: BriefInput): string {
  const { role, task } = input;
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
    ...(task === "adhoc_review" || task === "worker" ? [] : selfCheck(input)),
  ].join("\n");
}

/** Size of an input file for the brief: bytes and lines, so a role with a paged reader knows where the end is. */
function sizeNote(root: string, rel: string): string {
  try {
    const text = readFileSync(join(root, rel), "utf8");
    const lines = text.split("\n").length;
    return lines > 400 ? ` [${text.length} bytes, ${lines} lines: if your file tool returns a part, read on by line range until line ${lines}]` : "";
  } catch {
    return "";
  }
}

function writeRule(input: BriefInput): string {
  if (input.readOnly ?? READ_ONLY_ROLES.includes(input.role)) return "This is an advisory run: do not change any file.";
  switch (input.role) {
    case "planner":
      return REPORT_FILE_TASKS.has(input.task) ? `Do not change project files; write your report to \`.looprch/runs/${input.runId}/report.md\` (see the self-check below).` : "Do not change project files.";
    case "plan_debater":
    case "reviewer":
      return "You review; you do not need to change files.";
    case "implementer":
      return "Change the files your work needs. The Tester writes the phase's tests after you.";
    case "tester":
      return "Write and fix the tests; report application defects as failures for the Implementer.";
    case "worker":
      return "Do not change files.";
    default: {
      const never: never = input.role;
      throw new Error(`unhandled role ${String(never)}`);
    }
  }
}

export function assembleBrief(input: BriefInput): string {
  const tpl = readFileSync(join(packageRoot(), "assets", "templates", "brief.md"), "utf8");
  const inputs: string[] = [];
  let n = 1;
  const implementerRun = input.role === "implementer" && (input.task === "implementation" || input.task === "repair");
  const packetLine = input.packet
    ? implementerRun
      ? `\`${input.packet.path}\` — exact-source SEV3 packet (${input.packet.bytes} bytes). plan.md is your instruction; open the packet when you need the exact wording of a source.`
      : `\`${input.packet.path}\` — exact-source SEV3 packet (${input.packet.bytes} bytes). Read all of it.${sizeNote(input.root, input.packet.path)}`
    : input.phaseSource
      ? `\`${input.phaseSource}\` — current phase source.`
      : null;
  const planFirst = input.role === "plan_debater";
  if (packetLine && !planFirst) inputs.push(`${n++}. ${packetLine}`);
  const rules = projectPaths(input.root).userRules;
  if (existsSync(rules)) inputs.push(`${n++}. \`.looprch/user-rules.md\` — project rules every role follows.`);
  else inputs.push(`${n++}. \`.looprch/user-rules.md\` — does not exist: this project has no additional user rules. This is Looprch's authoritative answer; do not request the file.`);
  for (const i of input.inputs) inputs.push(`${n++}. \`${i.path}\` — ${i.why}${sizeNote(input.root, i.path)}`);
  if (packetLine && planFirst) inputs.push(`${n++}. ${packetLine} Read the plan above first; the packet is what you check it against.`);
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
    write_rule: writeRule(input),
    read_rule: implementerRun ? "Read plan.md completely, including any addenda at its end, then do the work in the Delta." : "Read every input listed below completely. Never summarize or skip the packet.",
    session_note: !input.resume
      ? ""
      : input.role === "reviewer" || input.role === "tester"
        ? "- You are continuing an earlier session for this phase. The code changed since your last run: inspect the current files and the diff, not your memory."
        : "- You are continuing an earlier session for this phase; re-read inputs only where the Delta requires it.",
    inputs: inputs.join("\n") || "(none)",
    task_text: taskText(input),
    delta: deltaText(input.delta, input.userNote),
    output_contract: outputContract(input),
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

export function writeBrief(root: string, runId: string, text: string): string {
  const rel = `.looprch/runs/${runId}/brief.md`;
  writeFileAtomic(join(root, rel), text);
  return rel;
}
