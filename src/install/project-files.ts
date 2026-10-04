import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageRoot } from "../core/constants.js";
import { writeFileAtomic } from "../core/fsx.js";
import type { Config } from "../core/config.js";
import { READ_ONLY_ROLES, SKILLS, type Role } from "../core/constants.js";
import { adapterFor } from "../agents/index.js";
import { GENERATED_MARKER, type GeneratedFile } from "../agents/types.js";
import type { LinkReport } from "./links.js";

export const AGENTS_BEGIN = "<!-- looprch:begin -->";
export const AGENTS_END = "<!-- looprch:end -->";
export const GITIGNORE_BEGIN = "# looprch:begin";
export const GITIGNORE_END = "# looprch:end";

export const IGNORED_RUNTIME = [
  ".looprch/runs/",
  ".looprch/packets/",
  ".looprch/test-evidence/",
  ".looprch/reports/",
  ".looprch/lock",
  ".looprch/backups/",
  ".sev3-cache/",
];

function replaceBlock(text: string, begin: string, end: string, block: string): string {
  const full = `${begin}\n${block.trimEnd()}\n${end}`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start !== -1 && stop > start) return text.slice(0, start) + full + text.slice(stop + end.length);
  const sep = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${full}\n`;
}

/** Insert or refresh the block; returns "created" | "updated" | "unchanged". */
export function upsertBlock(path: string, begin: string, end: string, block: string): "created" | "updated" | "unchanged" {
  const exists = existsSync(path);
  const before = exists ? readFileSync(path, "utf8") : "";
  const after = replaceBlock(before, begin, end, block);
  if (after === before) return "unchanged";
  writeFileAtomic(path, after);
  return exists ? "updated" : "created";
}

export function agentsMdBlock(): string {
  return readFileSync(join(packageRoot(), "assets", "templates", "agents-md-block.md"), "utf8");
}

export function gitignoreBlock(cfg: Config, skillDirs: string[]): string {
  const lines = ["# Looprch runtime files (machine-local)", ...IGNORED_RUNTIME, "# Looprch skill links (absolute paths; run `looprch add .` after cloning)"];
  for (const dir of [...new Set(skillDirs)].sort()) lines.push(`${dir}/lr-*`);
  if (!cfg.integrations.commit_generated) {
    const globs = cfg.agents.flatMap((id) => adapterFor(id).generatedGlobs);
    if (globs.length) lines.push("# Looprch-generated agent files", ...[...new Set(globs)].sort());
  }
  return lines.join("\n");
}

function isOwned(path: string): boolean {
  return readFileSync(path, "utf8").includes(GENERATED_MARKER);
}

export function writeGenerated(root: string, file: GeneratedFile, report: LinkReport): void {
  const path = join(root, file.path);
  if (existsSync(path)) {
    if (!isOwned(path)) {
      report.skipped_foreign.push(file.path);
      return;
    }
    if (readFileSync(path, "utf8") === file.content) return;
    writeFileAtomic(path, file.content);
    report.updated.push(file.path);
    return;
  }
  writeFileAtomic(path, file.content);
  report.created.push(file.path);
}

/** Files each enabled agent should have, given the configured roles. */
export function desiredAgentFiles(cfg: Config): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const id of cfg.agents) {
    const a = adapterFor(id);
    if (a.extraFiles) files.push(...a.extraFiles(SKILLS));
    if (!a.direct) continue;
    for (const [role, rc] of Object.entries(cfg.roles)) {
      if (!rc) continue;
      const assignments = [rc, ...rc.fallbacks];
      const direct = assignments.find((x) => x.mode === "direct" && x.agent === id);
      if (direct) files.push(a.direct.subagentFile(role as Role, direct.model, READ_ONLY_ROLES.includes(role as Role)));
    }
  }
  return files;
}

const GENERATED_DIRS = [".codex/agents", ".cursor/agents", ".opencode/agents", ".opencode/commands"];

/** Write desired files and delete Looprch-owned lr-* files that are no longer wanted. */
export function syncAgentFiles(root: string, cfg: Config, report: LinkReport): void {
  const desired = desiredAgentFiles(cfg);
  const wanted = new Set(desired.map((f) => f.path));
  for (const f of desired) writeGenerated(root, f, report);
  for (const dir of GENERATED_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      if (!name.startsWith("lr-") || wanted.has(rel)) continue;
      const path = join(abs, name);
      if (isOwned(path)) {
        rmSync(path, { force: true });
        report.removed.push(rel);
      }
    }
  }
}

export function removeAgentFiles(root: string, files: GeneratedFile[], report: LinkReport): void {
  for (const f of files) {
    const path = join(root, f.path);
    if (existsSync(path) && isOwned(path)) {
      rmSync(path, { force: true });
      report.removed.push(f.path);
      const parent = dirname(path);
      if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
    }
  }
}
