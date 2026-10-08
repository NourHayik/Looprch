import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { configExists, loadConfig, validateConfig, type AgentId, type Config } from "../core/config.js";
import { GITHUB_SPEC } from "../core/constants.js";
import { errorMessage } from "../core/errors.js";
import { nowIso } from "../core/clock.js";
import { readLock, pidAlive } from "../core/lock.js";
import { home, projectPaths } from "../core/paths.js";
import { loadState } from "../core/state.js";
import { adapterFor, detectBinary } from "../agents/index.js";
import { discoverClis, type DiscoveredCli } from "../delegate/discover.js";
import { locateRelay, relayInstallArgv } from "../delegate/locate.js";
import { verifyManifest } from "../install/manifest.js";
import { inspectSkillLinks, decideLinkModes } from "../install/links.js";
import { loadRegistry } from "../install/registry.js";
import { AGENTS_BEGIN, GITIGNORE_BEGIN } from "../install/project-files.js";
import { isOurShim } from "../install/shim.js";
import { readQuota } from "../quota/quotalens.js";
import { discover } from "../sev3/discovery.js";
import { pythonVersion } from "../sev3/toolkit.js";
import { baselineStatus } from "../git/baseline.js";
import { assertNot5x } from "./attach.js";
import { validationContext } from "./config.js";
import { e2eDoctorSummary } from "./e2e.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  generated_at: string;
  checks: DoctorCheck[];
}

function c(id: string, status: CheckStatus, summary: string, fix?: string): DoctorCheck {
  return fix ? { id, status, summary, fix } : { id, status, summary };
}

/** Agents a role may reach through a relay: delegate assignments plus Direct roles on another host (D-05). */
export function relayAgents(cfg: Config): AgentId[] {
  const set = new Set<AgentId>();
  for (const rc of Object.values(cfg.roles)) {
    if (!rc) continue;
    for (const a of [rc, ...rc.fallbacks]) if (a.mode === "delegate" || (cfg.lead_host && a.agent !== cfg.lead_host)) set.add(a.agent);
  }
  return [...set].filter((a) => !!adapterFor(a).delegate);
}

/** Auth from discovery; for CLIs without an auth probe, a reported model list counts as logged in. */
export function authCheck(id: AgentId, d: DiscoveredCli | undefined, discoveryError: string | null): DoctorCheck {
  const a = adapterFor(id);
  const check = `agent:${id}:auth`;
  if (!d) return c(check, "skip", discoveryError ?? "not reported by discovery");
  if (d.authenticated === false) return c(check, "fail", `${a.displayName} is not logged in`, `Log in with ${d.binary}`);
  if (d.authenticated) return c(check, "ok", `authenticated (${d.version ?? "?"})`);
  const models = d.models.status === "reported" ? d.models.values.length : 0;
  if (a.delegate?.authFromModels && models > 0) return c(check, "ok", `authenticated (${d.binary} models listed ${models} model${models === 1 ? "" : "s"})`);
  return c(check, "warn", "authentication unknown");
}

export function runDoctor(root: string, quick: boolean): DoctorReport {
  const checks: DoctorCheck[] = [];
  const node = process.versions.node;
  checks.push(Number(node.split(".")[0]) >= 22 ? c("node", "ok", `Node ${node}`) : c("node", "fail", `Node ${node} is older than 22`, "Install Node.js 22 or newer"));
  const py = pythonVersion();
  checks.push(py.ok ? c("python", "ok", `Python ${py.version}`) : c("python", "fail", `Python 3.10+ not found (${py.version ?? "missing"})`, "Install Python 3.10 or newer as python3"));
  const g = spawnSync("git", ["--version"], { encoding: "utf8" });
  checks.push(g.status === 0 ? c("git", "ok", g.stdout.trim()) : c("git", "fail", "git not found", "Install git"));

  if (existsSync(home.current())) {
    const m = verifyManifest(home.current());
    checks.push(m.ok ? c("core_integrity", "ok", `Core files verified (${m.files})`) : c("core_integrity", "fail", `Core install differs from its manifest: ${[...m.missing, ...m.mismatched].slice(0, 3).join(", ")}`, `Reinstall: npx ${GITHUB_SPEC} install`));
  } else checks.push(c("core_integrity", "fail", `Looprch is not installed centrally (${home.current()} missing)`, `Run: npx ${GITHUB_SPEC} install`));
  const shim = home.shim();
  const onPath = (process.env.PATH ?? "").split(":").includes(dirname(shim));
  checks.push(!isOurShim(shim) ? c("shim_path", "warn", `No looprch shim at ${shim}`, "Run: looprch install") : onPath ? c("shim_path", "ok", `${shim} on PATH`) : c("shim_path", "warn", `${dirname(shim)} is not on PATH`, 'Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"'));

  try {
    assertNot5x(root);
    checks.push(c("layout_5x", "ok", "No Looprch 5.x layout"));
  } catch (err) {
    checks.push(c("layout_5x", "fail", errorMessage(err), "Move the old .looprch/ folder away"));
  }
  if (!configExists(root)) {
    checks.push(c("project_attached", "fail", `${root} is not attached to Looprch`, "Run: looprch add ."));
    return { ok: !checks.some((x) => x.status === "fail"), generated_at: nowIso(), checks };
  }
  const cfg = loadConfig(root);
  checks.push(c("project_attached", "ok", `Attached; agents: ${cfg.agents.join(", ") || "none"}`));

  const entry = loadRegistry().find((e) => e.path === root);
  const modes = entry?.link_mode ?? decideLinkModes(cfg.agents, false);
  const problems = Object.entries(modes).flatMap(([dir, mode]) => inspectSkillLinks(root, dir, mode).problems);
  checks.push(problems.length ? c("skill_links", "fail", problems.slice(0, 4).join("; "), "Run: looprch add . (repairs Looprch links only)") : c("skill_links", "ok", `Skills present in ${Object.keys(modes).join(", ")}`));
  const agentsMd = join(root, "AGENTS.md");
  checks.push(existsSync(agentsMd) && readFileSync(agentsMd, "utf8").includes(AGENTS_BEGIN) ? c("agents_md_block", "ok", "AGENTS.md block present") : c("agents_md_block", "fail", "AGENTS.md Looprch block missing", "Run: looprch add ."));
  const gi = join(root, ".gitignore");
  checks.push(existsSync(gi) && readFileSync(gi, "utf8").includes(GITIGNORE_BEGIN) ? c("gitignore_block", "ok", ".gitignore block present") : c("gitignore_block", "fail", ".gitignore Looprch block missing", "Run: looprch add ."));

  const disc = quick ? null : discoverClis(root, false);
  for (const id of cfg.agents) {
    const a = adapterFor(id);
    const bin = detectBinary(a);
    checks.push(bin ? c(`agent:${id}:binary`, "ok", `${a.displayName}: ${bin.path}`) : c(`agent:${id}:binary`, id === cfg.lead_host ? "warn" : "fail", `${a.displayName} CLI (${a.binaries.join(" or ")}) not on PATH`, `Install ${a.displayName} or remove it: looprch remove ${id}`));
    if (quick) checks.push(c(`agent:${id}:auth`, "skip", "skipped (--quick)"));
    else checks.push(authCheck(id, disc?.data?.discovered.find((x) => x.key === id), disc?.error ?? null));
    if (a.delegate?.writeFlags?.length) checks.push(c(`agent:${id}:permissions`, "ok", `${a.displayName} write roles run with ${a.delegate.writeFlags.join(" ")} (tool permissions auto-approved); read-only roles stay sandboxed`));
    const unverified = Object.entries(a.verified).filter(([, v]) => v !== "verified").map(([k]) => k);
    if (a.experimental) checks.push(c(`agent:${id}:support`, "warn", `${a.displayName} support is experimental (spikes not run: ${unverified.join(", ")})`));
    else if (unverified.length) checks.push(c(`agent:${id}:support`, "warn", `Unverified for ${a.displayName}: ${unverified.join(", ")} (see docs/dev/spike-results.md)`));
    for (const n of a.postInstallNotes) if (/hermes skills trust|trust the folder/.test(n)) checks.push(c(`agent:${id}:trust`, "warn", n));
    if (id === "hermes" && existsSync(join(root, ".hermes.md")) && !readFileSync(join(root, ".hermes.md"), "utf8").includes(AGENTS_BEGIN))
      checks.push(c("agent:hermes:context", "warn", "Hermes reads .hermes.md instead of AGENTS.md; it has no Looprch block", "Copy the Looprch block from AGENTS.md into .hermes.md"));
  }
  let dupWarned = false;
  for (const id of relayAgents(cfg)) {
    const r = locateRelay(root, id);
    checks.push(r ? c(`relay:${id}`, "ok", `${r.skill} ${r.version ?? ""} at ${r.path}`) : c(`relay:${id}`, "fail", `${adapterFor(id).delegate!.skill} not installed`, `looprch install-relay ${id}   (runs: npx ${relayInstallArgv(id).join(" ")})`));
    if (r?.duplicates.length) {
      dupWarned = true;
      checks.push(c("relay_duplicates", "warn", `${r.skill}: differing copies at ${r.duplicates.map((d) => d.path).join(", ")}; using ${r.path}`));
    }
  }
  if (!dupWarned) checks.push(c("relay_duplicates", "ok", "No conflicting relay copies"));

  if (quick) checks.push(c("quotalens", "skip", "skipped (--quick)"));
  else {
    const q = readQuota();
    checks.push(q.data ? c("quotalens", "ok", `QuotaLens providers: ${q.data.providers.map((p) => `${p.id}${p.status !== "ok" || p.stale ? `(${p.stale ? "stale" : p.status})` : ""}`).join(", ")}`) : c("quotalens", "warn", `QuotaLens not available (${q.error}); usage limits are treated as unknown`, "Optional: install quotalens for the wait/fallback rule"));
  }

  try {
    const r = discover(root, cfg.spec.gates_ack?.manifest_sha256 ?? null);
    checks.push(c("sev3_package", "ok", `${r.project?.title ?? r.project?.id} (${r.phases.length} phases)`));
    checks.push(r.toolkit_trusted ? c("sev3_toolkit", "ok", `Toolkit ${r.toolkit_version} matches the trusted copy`) : c("sev3_toolkit", "fail", `Toolkit differs: ${r.tool_mismatches.join(", ")}`, "A package cannot ship a modified reader; regenerate it with SEV3 toolkit 1.2.0"));
    if (r.unreadable_files.length) checks.push(c("sev3_readable", "fail", `Unreadable: ${r.unreadable_files.slice(0, 3).join("; ")}`, "Fix permissions, e.g. chmod -R u+rX,go+rX phases requirements"));
    checks.push(r.verify.ok ? c("sev3_verify", "ok", "Specification verified (the application is not verified until gates pass)") : c("sev3_verify", "fail", `verify_package.py: ${r.verify.error}`));
    checks.push(r.gates_acknowledged ? c("gates_ack", "ok", "Gate commands acknowledged") : c("gates_ack", "warn", `Gate commands not acknowledged: ${r.gate_commands.map((x) => x.argv0).join(", ")}`, `looprch init ack-gates --manifest-sha256 ${r.manifest_sha256}`));
  } catch (err) {
    checks.push(c("sev3_package", "fail", errorMessage(err), "Put the SEV3 package at the project root"));
  }

  const b = baselineStatus(root);
  checks.push(b.repo ? c("git_repo", "ok", `Git repository on ${b.branch ?? "(detached)"}`) : c("git_repo", "warn", "No git repository yet", "Looprch creates one before the first phase, or run: looprch init git"));
  if (b.repo) {
    checks.push(b.identity ? c("git_identity", "ok", "git identity configured") : c("git_identity", "fail", "git user.name/user.email missing", 'git config --global user.name "Name" && git config --global user.email you@example.com'));
    const dirty = b.dirty.filter((p) => ![".looprch/config.json", ".looprch/state.json", ".looprch/events.jsonl"].includes(p));
    checks.push(!b.has_commits ? c("git_clean", "warn", "No commits yet; the first phase offers a baseline commit") : dirty.length ? c("git_clean", "warn", `${dirty.length} uncommitted file(s)`, "Commit or stash your changes before the next phase") : c("git_clean", "ok", "Working tree clean"));
  }

  const v = validateConfig(cfg, validationContext(root, true));
  checks.push(v.ok ? c("roles_valid", v.warnings.length ? "warn" : "ok", v.warnings.length ? `Roles valid; ${v.warnings.join("; ")}` : "Roles configured and valid") : c("roles_valid", "fail", v.errors.join("; "), "Run /lr-init or looprch config set-role ..."));

  const e2e = e2eDoctorSummary(root, cfg);
  checks.push(c("e2e", e2e.status, e2e.summary, e2e.fix));

  const state = loadState(root);
  if (state.current) {
    for (const [role, rc] of Object.entries(cfg.roles)) {
      if (!rc) continue;
      const budget = rc.context_kb ?? cfg.context_kb[rc.agent] ?? null;
      const packet = join(projectPaths(root).packets, state.current.phase, `${role.replace("_", "-")}.md`);
      if (!budget) checks.push(c(`context_budget:${role}`, "skip", "budget not set"));
      else if (existsSync(packet)) {
        const kb = Math.ceil(statSync(packet).size / 1024);
        checks.push(kb > budget ? c(`context_budget:${role}`, "warn", `Packet ${kb} KB exceeds ${rc.agent} budget ${budget} KB`, "Add a fallback with a larger context budget") : c(`context_budget:${role}`, "ok", `Packet ${kb} KB within ${budget} KB`));
      }
    }
  }
  const lock = readLock(root);
  checks.push(!lock ? c("lock", "ok", "Project lock free") : pidAlive(lock.pid) ? c("lock", "warn", `Lock held by pid ${lock.pid} (${lock.command})`) : c("lock", "warn", `Stale lock from pid ${lock.pid}; it will be reclaimed`));
  return { ok: !checks.some((x) => x.status === "fail"), generated_at: nowIso(), checks };
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { quick: { type: "boolean" }, root: { type: "string" } }, "looprch doctor [--quick] [--json]");
  const r = runDoctor(projectRoot(values.root), !!values.quick);
  const icon: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };
  out(!!values.json, r, () => [...r.checks.map((x) => `${icon[x.status]} ${x.id.padEnd(24)} ${x.summary}${x.fix ? `\n     fix: ${x.fix}` : ""}`), "", r.ok ? "Ready." : "Not ready: fix the FAIL items above."].join("\n"));
  return r.ok ? 0 : 1;
}
