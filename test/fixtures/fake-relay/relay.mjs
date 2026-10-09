#!/usr/bin/env node
// Fake delegate-skills relay for Looprch tests. Speaks the relay CLI (subset) and writes
// delegate-relay.result.v1. Behaviour is scripted by the JSON file in LOOPRCH_FAKE_SCENARIO.
//
// Scenario: { "rules": [ { "agent"?, "role"?, "phase"?, "task"?, "nth"?, ...behaviour } ] }
// Behaviour keys: status ("completed"|"failed"|"timeout"|"aborted"|"unavailable"), decision,
// variant (fixture subfolder to copy, default "app"/"tests"), sleep_ms, stderr, no_session,
// read_only_violation, touch (path to create), usage_error, omit_block, findings, failures,
// final (literal final message), kill_self, raw_findings; planner: plan (the whole plan block),
// two_sessions, deferrals, omit_dispositions, disposition, new_todos; plan_debater: verdict;
// implementer: todos_done (list), resolution_status.
// report_file writes the report to the run's report.md; report_final is then the final message:
// "block" (a pointer plus the result block without the markdown) or a literal string.
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agent = process.env.FAKE_AGENT || basename(resolve(here, "..")).replace(/-delegate$/, "");
const args = process.argv.slice(2);
const opt = {};
const flags = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (["--brief", "--cd", "--out-dir", "--model", "--effort", "--variant", "--session", "--conversation", "--timeout", "--print-timeout"].includes(a)) opt[a.slice(2)] = args[++i];
  else if (a.startsWith("--")) flags.add(a.slice(2));
  else {
    process.stderr.write(`usage error: unexpected ${a}\n`);
    process.exit(2);
  }
}
if (!opt.brief || !existsSync(opt.brief)) {
  process.stderr.write("usage error: --brief <file> required\n");
  process.exit(2);
}
const cwd = resolve(opt.cd || process.cwd());
const outDir = resolve(opt["out-dir"] || join(cwd, ".fake-relay-out"));
mkdirSync(outDir, { recursive: true });
const brief = readFileSync(opt.brief, "utf8");
const metaLine = (/<!-- looprch: ([^>]*?) -->/.exec(brief) || [])[1] || "";
const meta = Object.fromEntries([...metaLine.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
const role = meta.role || "worker";
const phase = meta.phase || "P-000";
const task = meta.task || "task";
const fixtures = process.env.FAKE_IMPL_DIR;
const scenarioPath = process.env.LOOPRCH_FAKE_SCENARIO;
const scenario = scenarioPath && existsSync(scenarioPath) ? JSON.parse(readFileSync(scenarioPath, "utf8")) : { rules: [] };
const stateDir = scenarioPath ? dirname(scenarioPath) : outDir;
const countsPath = join(stateDir, "fake-counts.json");
const counts = existsSync(countsPath) ? JSON.parse(readFileSync(countsPath, "utf8")) : {};
const key = `${role}:${phase}:${task}`;
counts[key] = (counts[key] || 0) + 1;
writeFileSync(countsPath, JSON.stringify(counts));
const nth = counts[key];
const rule =
  (scenario.rules || []).find(
    (r) => (!r.agent || r.agent === agent) && (!r.role || r.role === role) && (!r.phase || r.phase === phase) && (!r.task || r.task === task) && (!r.nth || r.nth === nth),
  ) || {};
appendFileSync(join(stateDir, "fake-calls.jsonl"), JSON.stringify({ agent, role, phase, task, nth, args, session: opt.session || opt.conversation || null, pid: process.pid }) + "\n");

if (rule.usage_error) {
  process.stderr.write("usage error: scripted\n");
  process.exit(2);
}
if (rule.kill_self) process.kill(process.pid, "SIGKILL");
if (rule.sleep_ms) await new Promise((r) => setTimeout(r, rule.sleep_ms));

const sessionField = agent === "codex" ? "threadId" : agent === "agy" ? "conversationId" : "sessionId";
const session = rule.no_session ? null : opt.session || opt.conversation || `ses_${agent}_${randomBytes(4).toString("hex")}`;

function git(argv) {
  try {
    return execFileSync("git", argv, { cwd, encoding: "utf8" });
  } catch {
    return "";
  }
}
function copyFixture(sub) {
  if (!fixtures) return [];
  const src = join(fixtures, phase, sub);
  if (!existsSync(src)) return [];
  cpSync(src, cwd, { recursive: true });
  return [src];
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
const phaseDir = join(cwd, ".looprch", "phases", phase);
const manifestPhase = (readJson(join(cwd, "phases", "manifest.json"), { phases: [] }).phases || []).find((p) => p.id === phase) || { requirements: [], gates: [] };
/** Finding ids listed as Delta bullets in the brief ("- R-1 [high, …]: …"). */
const deltaIds = () => {
  const delta = brief.split("\n## Delta\n")[1]?.split("\n## Output contract")[0] ?? "";
  return [...delta.matchAll(/^- ([A-Za-z][\w.]*-[\w.-]+?)(?: \[| \(|:)/gm)].map((m) => m[1]).filter((id) => id !== "read");
};
function defaultPlan() {
  const todos = rule.two_sessions ? [{ id: "T-1", title: "Write noteapp.py", section: "1. App" }, { id: "T-2", title: "Wire the CLI", section: "2. CLI" }] : [{ id: "T-1", title: "Write noteapp.py", section: "1. App" }];
  return {
    todos,
    sessions: rule.two_sessions ? [["T-1"], ["T-2"]] : [todos.map((t) => t.id)],
    requirements: Object.fromEntries(manifestPhase.requirements.map((r) => [r, ["T-1"]])),
    deferrals: rule.deferrals ?? [],
  };
}
const ledger = () => readJson(join(phaseDir, "debate.json"), { entries: [] });
const openItems = () => ledger().entries.filter((x) => x.status === "open").map((x) => x.id);

let decision = rule.decision;
let body = `Fake ${agent} ${role} for ${phase} (${task}, call ${nth}).`;
const extra = {};
switch (role) {
  case "planner":
    decision ||= task === "synthesis" || task === "revise" ? "plan_final" : task === "context_answer" ? "context_answer" : "plan_ready";
    body = task === "context_answer" ? `Use ValueError for an invalid id (call ${nth}).` : `# Plan for ${phase}\n\n## Overview\n\nScripted.\n\n## Todo list\n\n- T-1: Write noteapp.py\n\n${body}`;
    if (decision === "plan_ready" || decision === "plan_final") extra.plan = rule.plan ?? defaultPlan();
    if ((task === "synthesis" || task === "revise") && !rule.omit_dispositions) extra.debate_dispositions = openItems().map((id) => ({ id, decision: rule.disposition ?? "accept", note: "scripted" }));
    if (task === "context_answer" && rule.new_todos) extra.new_todos = rule.new_todos;
    break;
  case "plan_debater": {
    if (task === "rebuttal") {
      decision ||= rule.verdict === "upheld" ? "findings" : "agree";
      extra.verdicts = openItems().map((id) => ({ id, verdict: rule.verdict ?? "resolved", note: "scripted" }));
      if (rule.findings) extra.findings = rule.findings;
    } else {
      decision ||= "no_findings";
      if (decision === "findings") extra.findings = rule.raw_findings ?? rule.findings ?? [{ id: "D-1", severity: "medium", summary: "Clarify error handling.", suggestion: "say which exception" }];
    }
    break;
  }
  case "implementer":
    if (task === "handover") {
      decision ||= "handover_ready";
      extra.limitations = [];
      body = `## Phase Summary\nDone.\n\n## Key Decisions & Notes\nNone.\n\n${body}`;
    } else {
      decision ||= "implemented";
      copyFixture(rule.variant || "app");
      if (decision === "needs_context") extra.context_request = { question: "Which error type?", reason: "The plan does not say" };
      extra.files_changed = [];
      if (task === "implementation") extra.todos_done = rule.todos_done ?? deltaIds().filter((id) => /^T-/.test(id));
      if (task === "repair") {
        const app = join(cwd, "noteapp.py");
        if (existsSync(app)) appendFileSync(app, `# repaired (${task} ${nth})\n`);
        if (rule.resolution_status) extra.resolutions = deltaIds().map((id) => ({ id, status: rule.resolution_status, note: "scripted" }));
      }
    }
    break;
  case "tester": {
    copyFixture(rule.variant || "tests");
    decision ||= "pass";
    extra.tests_written = [];
    if (decision === "fail") extra.failures = rule.failures || [{ id: "T-1", summary: "scripted failure" }];
    break;
  }
  case "reviewer": {
    decision ||= "approve";
    if (decision === "changes_requested") extra.findings = rule.raw_findings ?? rule.findings ?? [{ id: "R-1", severity: "high", summary: "Scripted finding", files: ["noteapp.py"], fix: "Scripted fix condition", owner: "implementer" }];
    else if (rule.findings || rule.raw_findings) extra.findings = rule.raw_findings ?? rule.findings;
    break;
  }
  default:
    decision ||= "answered";
    extra.evidence = [{ path: "noteapp.py", note: "scripted" }];
}
if (rule.touch) writeFileSync(join(cwd, rule.touch), "touched\n");
const block = JSON.stringify({ role, decision, ...extra });
let finalMessage = rule.final ?? (rule.omit_block ? body : `${body}\n\n\`\`\`looprch-result\n${block}\n\`\`\``);
if (rule.report_file && meta.run_id) {
  writeFileSync(join(cwd, ".looprch", "runs", meta.run_id, "report.md"), finalMessage);
  finalMessage =
    rule.report_final === "block"
      ? `Report written to .looprch/runs/${meta.run_id}/report.md.\n\n\`\`\`looprch-result\n${block}\n\`\`\``
      : rule.report_final ?? "Report written to the report file; looprch check printed ok.";
}
const statusMap = { unavailable: `${agent}_unavailable` };
const status = rule.status ? statusMap[rule.status] || rule.status : "completed";
const exitCode = status === "completed" ? 0 : status === "timeout" ? 124 : status.endsWith("_unavailable") ? 127 : 1;
const touched = git(["status", "--porcelain"]).split("\n").filter(Boolean).map((l) => l.slice(3));
const result = {
  schema: "delegate-relay.result.v1",
  status,
  exitCode,
  signal: null,
  [sessionField]: session,
  finalMessage: status === "completed" ? finalMessage : "",
  touchedFiles: touched,
  ...(rule.stderr ? { stderrTail: rule.stderr } : {}),
  ...(flags.has("read-only") && (agent === "agy" || agent === "grok") ? { readOnlyViolation: !!rule.read_only_violation } : {}),
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2));
if (rule.stderr) process.stderr.write(rule.stderr + "\n");
process.stdout.write(`relay: ${status}\n`);
process.exit(exitCode);
