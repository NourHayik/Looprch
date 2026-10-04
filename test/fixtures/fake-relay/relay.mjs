#!/usr/bin/env node
// Fake delegate-skills relay for Looprch tests. Speaks the relay CLI (subset) and writes
// delegate-relay.result.v1. Behaviour is scripted by the JSON file in LOOPRCH_FAKE_SCENARIO.
//
// Scenario: { "rules": [ { "agent"?, "role"?, "phase"?, "task"?, "nth"?, ...behaviour } ] }
// Behaviour keys: status ("completed"|"failed"|"timeout"|"aborted"|"unavailable"), decision,
// variant (fixture subfolder to copy, default "app"/"tests"), sleep_ms, stderr, no_session,
// read_only_violation, touch (path to create), usage_error, omit_block, omit_new_file,
// findings, failures, final (literal final message), kill_self.
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
  if (["--brief", "--cd", "--out-dir", "--model", "--effort", "--variant", "--session", "--conversation", "--timeout"].includes(a)) opt[a.slice(2)] = args[++i];
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
function changedSinceBase() {
  const base = meta.phase_base;
  const out = { modified_files: [], new_files: [], deleted_files: [], renamed: [] };
  if (!base) return out;
  const ignore = (p) => p.startsWith(".looprch/") || p === "phases/todo.md";
  for (const line of git(["diff", "--name-status", "-M", base]).split("\n").filter(Boolean)) {
    const [st, a, b] = line.split("\t");
    if (st.startsWith("R")) {
      if (!ignore(b)) out.renamed.push({ from: a, to: b });
    } else if (!ignore(a)) (st === "A" ? out.new_files : st === "D" ? out.deleted_files : out.modified_files).push(a);
  }
  for (const p of git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) if (!ignore(p)) out.new_files.push(p);
  return out;
}

let decision = rule.decision;
let body = `Fake ${agent} ${role} for ${phase} (${task}, call ${nth}).`;
const extra = {};
switch (role) {
  case "planner":
    decision ||= task === "synthesis" ? "plan_final" : task === "context_answer" ? "context_answer" : "plan_ready";
    body = `## Plan for ${phase}\n\n1. Implement the scoped change.\n2. Tester covers the declared gates.\n\n${body}`;
    break;
  case "plan_debater":
    decision ||= "no_findings";
    if (decision === "findings") extra.findings = rule.findings || [{ id: "D-1", severity: "medium", summary: "Clarify error handling." }];
    break;
  case "implementer":
    if (task === "handover") {
      decision ||= "handover_ready";
      const lists = changedSinceBase();
      if (rule.omit_new_file) lists.new_files = lists.new_files.slice(1);
      Object.assign(extra, lists, { verification_ids: [], limitations: [] });
      body = `## Phase Summary\nDone.\n\n## Key Decisions & Notes\nNone.\n\n${body}`;
    } else {
      decision ||= "implemented";
      copyFixture(rule.variant || "app");
      if (decision === "needs_context") extra.context_request = { question: "Which error type?", reason: "Contract unclear" };
      extra.files_changed = [];
    }
    break;
  case "tester":
    copyFixture(rule.variant || "tests");
    decision ||= "pass";
    extra.tests_written = [];
    if (decision === "fail") extra.failures = rule.failures || [{ id: "T-1", summary: "scripted failure" }];
    break;
  case "reviewer":
    decision ||= "approve";
    if (decision === "changes_requested") extra.findings = rule.findings || [{ id: "R-1", severity: "high", summary: "Scripted finding", files: ["noteapp.py"] }];
    break;
  default:
    decision ||= "answered";
    extra.evidence = [{ path: "noteapp.py", note: "scripted" }];
}
if (rule.touch) writeFileSync(join(cwd, rule.touch), "touched\n");
const block = JSON.stringify({ role, decision, ...extra });
const finalMessage = rule.final ?? (rule.omit_block ? body : `${body}\n\n\`\`\`looprch-result\n${block}\n\`\`\``);
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
