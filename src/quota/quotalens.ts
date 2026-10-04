import { spawnSync } from "node:child_process";
import { now } from "../core/clock.js";
import { readJsonIfExists, writeJsonAtomic } from "../core/fsx.js";
import { home } from "../core/paths.js";

export interface QuotaLimit {
  id: string;
  category: string;
  remaining_percent: number | null;
  resets_at: string | null;
  reset_countdown_seconds?: number | null;
}

export interface QuotaProvider {
  id: string;
  installed?: boolean;
  auth_state?: string;
  usage_capability?: string;
  status: string;
  stale: boolean;
  limits: QuotaLimit[];
}

export interface QuotaData {
  schema_version: string;
  generated_at: string;
  providers: QuotaProvider[];
}

const CACHE_TTL_MS = 60_000;

interface Cached {
  at: number;
  data: QuotaData | null;
  error: string | null;
}

/** `quotalens status --json` (30 s timeout), cached for 60 s machine-locally. null = unknown. */
export function readQuota(opts: { force?: boolean; cacheOnly?: boolean } = {}): { data: QuotaData | null; error: string | null; cached: boolean } {
  const cached = readJsonIfExists<Cached>(home.quotaCache());
  if (cached && (opts.cacheOnly || (!opts.force && now() - cached.at < CACHE_TTL_MS))) return { data: cached.data, error: cached.error, cached: true };
  if (opts.cacheOnly) return { data: null, error: "no cached QuotaLens data", cached: true };
  const r = spawnSync("quotalens", ["status", "--json"], { encoding: "utf8", timeout: 30_000 });
  let data: QuotaData | null = null;
  let error: string | null = null;
  if (r.error) error = (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "quotalens is not installed" : r.error.message;
  else if (r.status !== 0) error = (r.stderr || `quotalens exited ${r.status}`).trim().slice(0, 300);
  else {
    try {
      const parsed = JSON.parse(r.stdout) as QuotaData;
      if (!Array.isArray(parsed.providers)) throw new Error("no providers");
      data = parsed;
    } catch (err) {
      error = `quotalens printed unexpected JSON: ${(err as Error).message}`;
    }
  }
  try {
    writeJsonAtomic(home.quotaCache(), { at: now(), data, error } satisfies Cached);
  } catch {
    // cache is optional
  }
  return { data, error, cached: false };
}
