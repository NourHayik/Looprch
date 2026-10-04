import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { SKILLS } from "../core/constants.js";
import { ensureDir, writeFileAtomic } from "../core/fsx.js";
import { home, looprchHome } from "../core/paths.js";
import type { AgentId } from "../core/config.js";
import { adapterFor } from "../agents/index.js";
import type { LinkMode, RegistryEntry } from "./registry.js";

export const VERSION_STAMP = ".looprch-version";

export interface LinkReport {
  created: string[];
  updated: string[];
  skipped_foreign: string[];
  removed: string[];
}

export function emptyReport(): LinkReport {
  return { created: [], updated: [], skipped_foreign: [], removed: [] };
}

export function isWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function coreVersion(): string {
  const vf = join(home.current(), "VERSION");
  return existsSync(vf) ? readFileSync(vf, "utf8").trim() : "unknown";
}

function isOwnedLinkTarget(target: string): boolean {
  const abs = resolve(target);
  return abs.startsWith(resolve(looprchHome()) + "/");
}

type EntryKind = "absent" | "our_link" | "our_copy" | "foreign";

function classify(path: string): EntryKind {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) return isOwnedLinkTarget(readlinkSync(path)) ? "our_link" : "foreign";
  if (st.isDirectory() && existsSync(join(path, VERSION_STAMP))) return "our_copy";
  return "foreign";
}

/** Skill dirs used by the selected agents, with the link mode each needs. */
export function decideLinkModes(agents: AgentId[], forceCopy: boolean): Record<string, LinkMode> {
  const modes: Record<string, LinkMode> = {};
  const forceSymlink = process.env.LOOPRCH_FORCE_SYMLINK === "1";
  for (const id of agents) {
    const a = adapterFor(id);
    for (const dir of a.skillDirs) {
      const needsCopy = !forceSymlink && (forceCopy || isWsl() || a.followsSymlinks !== true);
      if (needsCopy || modes[dir] === "copy") modes[dir] = "copy";
      else modes[dir] = "symlink";
    }
  }
  return modes;
}

/** Make every lr-* skill appear in `<root>/<skillDir>` and remove dangling Looprch entries. */
export function ensureSkillLinks(root: string, skillDir: string, mode: LinkMode, report: LinkReport = emptyReport()): LinkReport {
  const dir = join(root, skillDir);
  ensureDir(dir);
  const source = home.skills();
  const version = coreVersion();
  for (const skill of SKILLS) {
    const path = join(dir, skill);
    const rel = join(skillDir, skill);
    const target = join(source, skill);
    const kind = classify(path);
    if (kind === "foreign") {
      report.skipped_foreign.push(rel);
      continue;
    }
    if (mode === "symlink") {
      if (kind === "our_link" && readlinkSync(path) === target) continue;
      rmSync(path, { recursive: true, force: true });
      symlinkSync(target, path);
      (kind === "absent" ? report.created : report.updated).push(rel);
    } else {
      if (kind === "our_copy" && readFileSync(join(path, VERSION_STAMP), "utf8").trim() === version) continue;
      rmSync(path, { recursive: true, force: true });
      cpSync(target, path, { recursive: true, dereference: true });
      writeFileAtomic(join(path, VERSION_STAMP), `${version}\n`);
      (kind === "absent" ? report.created : report.updated).push(rel);
    }
  }
  removeDangling(root, skillDir, report);
  return report;
}

function removeDangling(root: string, skillDir: string, report: LinkReport): void {
  const dir = join(root, skillDir);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("lr-") || (SKILLS as readonly string[]).includes(name)) continue;
    const path = join(dir, name);
    const kind = classify(path);
    if (kind === "our_link" || kind === "our_copy") {
      rmSync(path, { recursive: true, force: true });
      report.removed.push(join(skillDir, name));
    }
  }
}

export function removeSkillLinks(root: string, skillDir: string, report: LinkReport = emptyReport()): LinkReport {
  const dir = join(root, skillDir);
  if (!existsSync(dir)) return report;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("lr-")) continue;
    const path = join(dir, name);
    const kind = classify(path);
    if (kind === "our_link" || kind === "our_copy") {
      rmSync(path, { recursive: true, force: true });
      report.removed.push(join(skillDir, name));
    }
  }
  return report;
}

/** Check links without changing anything (doctor). */
export function inspectSkillLinks(root: string, skillDir: string, mode: LinkMode): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const skill of SKILLS) {
    const path = join(root, skillDir, skill);
    const kind = classify(path);
    if (kind === "absent") problems.push(`${skillDir}/${skill} is missing`);
    else if (kind === "foreign") problems.push(`${skillDir}/${skill} was not created by Looprch`);
    else if (kind === "our_link" && !existsSync(path)) problems.push(`${skillDir}/${skill} is a broken link`);
    else if (kind === "our_copy" && mode === "copy" && readFileSync(join(path, VERSION_STAMP), "utf8").trim() !== coreVersion())
      problems.push(`${skillDir}/${skill} is a copy from an older Looprch version`);
  }
  return { ok: problems.length === 0, problems };
}

/** After update: refresh copy-mode projects and drop dangling links everywhere. */
export function refreshRegisteredProjects(entries: RegistryEntry[]): { path: string; report: LinkReport }[] {
  const out: { path: string; report: LinkReport }[] = [];
  for (const e of entries) {
    if (!existsSync(e.path)) continue;
    const report = emptyReport();
    for (const [dir, mode] of Object.entries(e.link_mode)) ensureSkillLinks(e.path, dir, mode, report);
    out.push({ path: e.path, report });
  }
  return out;
}
