import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJsonIfExists, writeJsonAtomic } from "../core/fsx.js";
import { home } from "../core/paths.js";
import { nowIso } from "../core/clock.js";
import { VERSION } from "../core/constants.js";

export type LinkMode = "symlink" | "copy";

export interface RegistryEntry {
  path: string;
  agents: string[];
  link_mode: Record<string, LinkMode>;
  added_at: string;
  last_seen_version: string;
}

export function loadRegistry(): RegistryEntry[] {
  return readJsonIfExists<RegistryEntry[]>(home.registry()) ?? [];
}

export function saveRegistry(entries: RegistryEntry[]): void {
  writeJsonAtomic(home.registry(), entries);
}

export function upsertProject(path: string, agents: string[], linkMode: Record<string, LinkMode>): RegistryEntry {
  const abs = resolve(path);
  const entries = loadRegistry();
  const existing = entries.find((e) => e.path === abs);
  const entry: RegistryEntry = {
    path: abs,
    agents,
    link_mode: linkMode,
    added_at: existing?.added_at ?? nowIso(),
    last_seen_version: VERSION,
  };
  saveRegistry([...entries.filter((e) => e.path !== abs), entry].sort((a, b) => a.path.localeCompare(b.path)));
  return entry;
}

export function listProjects(): (RegistryEntry & { exists: boolean })[] {
  return loadRegistry().map((e) => ({ ...e, exists: existsSync(e.path) }));
}
