#!/usr/bin/env node
// Fake delegate-skills relay for Looprch tests. Speaks the relay CLI (subset) and writes
// delegate-relay.result.v1. Behaviour is scripted by the JSON file in LOOPRCH_FAKE_SCENARIO.
//
// Scenario: { "rules": [ { "agent"?, "role"?, "phase"?, "task"?, "nth"?, ...behaviour } ] }
// Behaviour keys: status ("completed"|"failed"|"timeout"|"aborted"|"unavailable"), decision,
// variant (fixture subfolder to copy, default "app"/"tests"), sleep_ms, stderr, no_session,
// read_only_violation, touch (path to create), usage_error, omit_block, omit_new_file,
// findings, failures, final (literal final message), kill_self, omit_resolutions; contract keys:
// drop_requirement, deferrals, contract, omit_dispositions, omit_amendment, contract_amendment,
// no_change, resolution_status, verifications, omit_verifications, bad_tests, raw_findings,
// omit_prior, prior, contract_review, omit_contract_review, no_test_change, omit_checks,
// two_packages, omit_work_packages, omit_repair_packages, package_size, omit_work_package.
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

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
const phaseDir = join(cwd, ".looprch", "phases", phase);
const manifestPhase = (readJson(join(cwd, "phases", "manifest.json"), { phases: [] }).phases || []).find((p) => p.id === phase) || { requirements: [], gates: [] };
const contractIds = () => {
  const c = readJson(join(phaseDir, "contract.json"));
  return c ? [...c.obligations, ...c.deferrals].map((x) => x.id) : [];
};
/** Finding ids listed as Delta bullets in the brief ("- R-1 [high, …]: …"). */
const deltaIds = () => {
  const delta = brief.split("\n## Delta\n")[1]?.split("\n## Output contract")[0] ?? "";
  return [...delta.matchAll(/^- ([A-Za-z][\w.]*-[\w.-]+?)(?: \[| \(|:)/gm)].map((m) => m[1]).filter((id) => id !== "read");
};
function defaultContract() {
  const incoming = readJson(join(phaseDir, "incoming-deferrals.json"), []);
  const contract = {
    obligations: [
      {
        id: "O-1",
        requirements: manifestPhase.requirements,
        kind: "behavior",
        statement: `The ${phase} change meets its mapped requirements.`,
        enforcement: "noteapp.py",
        verify: "Unit tests cover valid and invalid inputs.",
        gates: manifestPhase.gates.map((g) => g.id),
        ...(incoming.length ? { covers: incoming.map((d) => d.ref) } : {}),
      },
    ],
    deferrals: [],
  };
  if (rule.drop_requirement) contract.obligations[0].requirements = contract.obligations[0].requirements.filter((r) => r !== rule.drop_requirement);
  if (rule.deferrals) contract.deferrals = rule.deferrals;
  const wp = (id, deps) => ({ id, title: `Package ${id}`, depends_on: deps, obligations: ["O-1"], files: [{ path: "noteapp.py", action: "create", content: "validate_id(s) -> str" }], steps: ["Write noteapp.py as specified."], done_when: ["python3 -c 'import noteapp' exits 0"] });
  contract.work_packages = rule.omit_work_packages ? [] : rule.two_packages ? [wp("WP-1", []), wp("WP-2", ["WP-1"])] : [wp("WP-1", [])];
  return rule.contract ?? contract;
}
function testRef() {
  const dir = join(cwd, "tests");
  if (!existsSync(dir)) return "tests";
  const files = execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").filter((f) => /^test_.*\.py$/.test(f));
  return files.length ? `tests/${files[0]}` : "tests";
}

let decision = rule.decision;
let body = `Fake ${agent} ${role} for ${phase} (${task}, call ${nth}).`;
const extra = {};
switch (role) {
  case "planner":
    decision ||= task === "synthesis" || task === "revise" ? "plan_final" : task === "context_answer" ? "context_answer" : "plan_ready";
    body = `## Plan for ${phase}\n\n1. Implement the scoped change.\n2. Tester covers the declared gates.\n\n${body}`;
    if (decision === "plan_ready" || decision === "plan_final") extra.contract = defaultContract();
    if (task === "synthesis" && !rule.omit_dispositions) {
      const ids = readJson(join(cwd, ".looprch", "state.json"), {}).current?.debate_findings ?? [];
      extra.debate_dispositions = ids.map((id) => ({ id, decision: "accept", reason: "scripted", refs: ["O-1"] }));
    }
    if (task === "context_answer") {
      const design = /Repair design for ([^:]+):/.exec(brief);
      const amendFor = /\nFor ([^\n]+?), also amend the contract/.exec(brief);
      if (rule.contract_amendment) extra.contract_amendment = rule.contract_amendment;
      else if (design && amendFor && !rule.omit_amendment) {
        const ids = amendFor[1].split(",").map((s) => s.trim()).filter(Boolean);
        extra.contract_amendment = { obligations: [{ id: `O-D${nth}`, requirements: manifestPhase.requirements.slice(0, 1), kind: "invariant", statement: `Repair rule for ${ids.join(", ")}`, enforcement: "noteapp.py validate_id", verify: "negative and variant cases", gates: manifestPhase.gates.map((g) => g.id).slice(0, 1), resolves: ids }] };
      }
      if (design && !rule.omit_repair_packages) {
        const ids = design[1].split(",").map((s) => s.trim()).filter(Boolean);
        const groups = [];
        for (let i = 0; i < ids.length; i += rule.package_size ?? 5) groups.push(ids.slice(i, i + (rule.package_size ?? 5)));
        extra.repair_packages = groups.map((g, i) => ({ id: `RP-${i + 1}`, title: `Repair ${g.join(", ")}`, findings: g, files: [{ path: "noteapp.py", action: "modify", content: "validate_id rejects the cases in the Checks" }], steps: [`Repair ${g.join(", ")} in noteapp.py.`], done_when: ["python3 -m unittest exits 0"] }));
      }
    }
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
      const pkg = /Report "work_package": "([^"]+)"/.exec(brief);
      if (pkg && !rule.omit_work_package) extra.work_package = pkg[1];
      const owed = /Report `resolutions` for: ([^\n]*?)\.?\n/.exec(brief);
      if (owed && !rule.omit_resolutions) {
        const app = join(cwd, "noteapp.py");
        if (!rule.no_change && existsSync(app)) appendFileSync(app, `# repaired (${task} ${nth})\n`);
        extra.resolutions = owed[1].split(",").map((id) => id.trim()).filter(Boolean).map((id) => ({ id, status: rule.resolution_status || "fixed", note: "scripted", files: ["noteapp.py"] }));
      }
    }
    break;
  case "tester": {
    copyFixture(rule.variant || "tests");
    decision ||= "pass";
    extra.tests_written = [];
    if (decision === "fail") extra.failures = rule.failures || [{ id: "T-1", summary: "scripted failure" }];
    const ids = [...new Set([...contractIds(), ...deltaIds()])];
    const tests = rule.bad_tests ? ["tests/test_missing.py::test_nope"] : [testRef()];
    const reviewRepair = /Round \d+: review findings|could not back the claims below/.test(brief);
    if (reviewRepair && !rule.no_test_change && existsSync(join(cwd, tests[0]))) appendFileSync(join(cwd, tests[0]), `# verified (${nth})\n`);
    const checkCount = {};
    let currentId = null;
    for (const line of (brief.split("\n## Delta\n")[1] ?? "").split("\n")) {
      const head = /^- ([A-Za-z][\w.]*-[\w.-]+?)(?: \[| \(|:)/.exec(line);
      if (head) currentId = head[1];
      else if (currentId && /^  Check \d+:/.test(line)) checkCount[currentId] = (checkCount[currentId] ?? 0) + 1;
    }
    const checks = (id) => (checkCount[id] && !rule.omit_checks ? { checks: Array.from({ length: checkCount[id] }, (_, i) => ({ n: i + 1, tests })) } : {});
    if (!rule.omit_verifications) extra.verifications = rule.verifications ?? ids.map((id) => ({ id, status: "verified", tests, variants: ["scripted variant"], ...checks(id) }));
    break;
  }
  case "reviewer": {
    decision ||= "approve";
    const withCause = (list) =>
      list.map((f) => ({ cause: f.owner === "tester" ? "test" : "implementation", ...(f.severity === "high" || f.severity === "critical" ? { checks: ["scripted check: the cited example", "scripted check: a variant"] } : {}), ...f }));
    if (decision === "changes_requested") extra.findings = rule.raw_findings ?? withCause(rule.findings || [{ id: "R-1", severity: "high", summary: "Scripted finding", files: ["noteapp.py"], fix: "Scripted fix condition", owner: "implementer" }]);
    else if (rule.findings || rule.raw_findings) extra.findings = rule.raw_findings ?? withCause(rule.findings);
    body = `## Coverage\n\n- Scripted coverage.\n\n${body}`;
    if (task === "review") {
      const rereview = /Review round [2-9]\d* of/.test(brief);
      if (rereview && !rule.raw_findings) {
        const earlier = new Set(deltaIds());
        for (const f of extra.findings ?? []) f.origin ??= earlier.has(f.id) ? "unfixed" : "missed";
      }
      if (rereview && !rule.omit_prior) {
        const unfixed = new Set((extra.findings ?? []).filter((f) => f.origin === "unfixed").map((f) => f.id));
        extra.prior = rule.prior ?? deltaIds().map((id) => ({ id, status: unfixed.has(id) ? "unfixed" : "fixed" }));
      }
      if (!rereview && !rule.omit_contract_review) {
        const notMet = new Set((extra.findings ?? []).flatMap((f) => f.obligations ?? []));
        extra.contract_review = rule.contract_review ?? contractIds().map((id) => ({ id, status: notMet.has(id) ? "not_met" : "met" }));
      }
    }
    break;
  }
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
