import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "../core/config.js";
import { nowIso } from "../core/clock.js";
import { readJsonIfExists, writeJsonAtomic } from "../core/fsx.js";
import { home } from "../core/paths.js";
import { sha256File } from "../install/manifest.js";
import { adapterFor } from "../agents/index.js";

export interface RelayInfo {
  agent: AgentId;
  skill: string;
  path: string;
  version: string | null;
  sha256: string;
  found_at: string;
  duplicates: { path: string; sha256: string }[];
}

export function skillSearchDirs(root: string | null): string[] {
  const h = homedir();
  const dirs = [join(h, ".agents", "skills"), join(h, ".codex", "skills"), join(h, ".claude", "skills"), join(h, ".cursor", "skills")];
  return root ? [join(root, ".agents", "skills"), ...dirs] : dirs;
}

function skillVersion(skillDir: string): string | null {
  const p = join(skillDir, "SKILL.md");
  if (!existsSync(p)) return null;
  const m = /^\s*version:\s*["']?([0-9][^"'\s]*)/m.exec(readFileSync(p, "utf8"));
  return m ? m[1]! : null;
}

interface DoctorCache {
  relays?: Partial<Record<AgentId, RelayInfo>>;
  discover?: { at: string; key: string; data: unknown };
}

export function readDoctorCache(): DoctorCache {
  return readJsonIfExists<DoctorCache>(home.doctorCache()) ?? {};
}

export function writeDoctorCache(patch: Partial<DoctorCache>): void {
  try {
    writeJsonAtomic(home.doctorCache(), { ...readDoctorCache(), ...patch });
  } catch {
    // the cache is an optimization only
  }
}

/** Project .agents/skills first, then the global skill dirs. Never stored in project config. */
export function locateRelay(root: string | null, agent: AgentId): RelayInfo | null {
  const d = adapterFor(agent).delegate;
  if (!d) return null;
  const found: { path: string; sha256: string; dir: string }[] = [];
  for (const dir of skillSearchDirs(root)) {
    const skillDir = join(dir, d.skill);
    const p = join(skillDir, "scripts", "relay.mjs");
    if (existsSync(p)) found.push({ path: p, sha256: sha256File(p), dir: skillDir });
  }
  if (!found.length) return null;
  const chosen = found[0]!;
  const info: RelayInfo = {
    agent,
    skill: d.skill,
    path: chosen.path,
    version: skillVersion(chosen.dir),
    sha256: chosen.sha256,
    found_at: nowIso(),
    duplicates: found.slice(1).filter((f) => f.sha256 !== chosen.sha256).map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
  const cache = readDoctorCache();
  writeDoctorCache({ relays: { ...(cache.relays ?? {}), [agent]: info } });
  return info;
}

export function locateDiscoverScript(root: string | null): string | null {
  for (const dir of skillSearchDirs(root)) {
    const p = join(dir, "delegate-setup", "scripts", "discover.mjs");
    if (existsSync(p)) return p;
  }
  return null;
}

export function relayInstallArgv(agent: AgentId): string[] {
  const skill = adapterFor(agent).delegate?.skill;
  return ["-y", "skills", "add", "amElnagdy/delegate-skills", "-g", "-y", "--copy", "--agent", "codex", "--skill", skill ?? `${agent}-delegate`];
}
