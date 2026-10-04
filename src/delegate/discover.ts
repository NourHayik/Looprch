import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import type { AgentId } from "../core/config.js";
import { now, nowIso } from "../core/clock.js";
import { allAdapters, detectBinary } from "../agents/index.js";
import { locateDiscoverScript, readDoctorCache, writeDoctorCache } from "./locate.js";

export interface DiscoveredCli {
  key: string;
  binary: string;
  version: string | null;
  path: string;
  authenticated: boolean | null;
  supports: string[];
  models: { status: "reported" | "aliases" | "unsupported" | "failed"; values: string[]; truncated?: boolean };
}

export interface DiscoverData {
  version: string;
  discovered: DiscoveredCli[];
  missing: { key: string; binary: string; skill: string }[];
}

const TTL_MS = 24 * 3_600_000;

function cacheKey(): string {
  return allAdapters()
    .map((a) => {
      const b = detectBinary(a);
      if (!b) return `${a.id}:-`;
      try {
        return `${a.id}:${b.path}:${statSync(b.path).mtimeMs}`;
      } catch {
        return `${a.id}:${b.path}`;
      }
    })
    .join("|");
}

/** delegate-setup discover.mjs, cached for 24 h or until a binary changes. Never run at preflight. */
export function discoverClis(root: string | null, refresh = false): { data: DiscoverData | null; cached: boolean; at: string | null; error: string | null } {
  const key = cacheKey();
  const cache = readDoctorCache().discover;
  if (!refresh && cache && cache.key === key && now() - Date.parse(cache.at) < TTL_MS) return { data: cache.data as DiscoverData, cached: true, at: cache.at, error: null };
  const script = locateDiscoverScript(root);
  if (!script) return { data: null, cached: false, at: null, error: "delegate-setup (discover.mjs) is not installed" };
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) return { data: null, cached: false, at: null, error: (r.stderr || "discover.mjs failed").trim().slice(0, 300) };
  try {
    const data = JSON.parse(r.stdout) as DiscoverData;
    writeDoctorCache({ discover: { at: nowIso(), key, data } });
    return { data, cached: false, at: nowIso(), error: null };
  } catch {
    return { data: null, cached: false, at: null, error: "discover.mjs printed invalid JSON" };
  }
}

/** Models from the cached discovery only (no probing). agy lines are "id<TAB>label". */
export function cachedModels(agent: AgentId): string[] | null {
  const data = readDoctorCache().discover?.data as DiscoverData | undefined;
  const entry = data?.discovered.find((d) => d.key === agent);
  if (!entry || entry.models.status === "unsupported" || entry.models.status === "failed") return null;
  return entry.models.values.map((v) => v.split("\t")[0]!.trim()).filter(Boolean);
}

export function modelsFrom(data: DiscoverData | null, agent: AgentId): { status: string; models: string[] } {
  const entry = data?.discovered.find((d) => d.key === agent);
  if (!entry) return { status: "failed", models: [] };
  return { status: entry.models.status, models: entry.models.values.map((v) => v.split("\t")[0]!.trim()).filter(Boolean) };
}
