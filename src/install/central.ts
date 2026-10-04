import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { LrError } from "../core/errors.js";
import { ensureDir, readJsonIfExists, writeJsonAtomic } from "../core/fsx.js";
import { home } from "../core/paths.js";
import { verifyManifest } from "./manifest.js";

export const PACKAGE_ENTRIES = ["dist", "assets", "vendor", "schemas", "VERSION", "MANIFEST.sha256"];

interface InstallRecord {
  current: string | null;
  previous: string | null;
}

export function readVersionOf(dir: string): string {
  const vf = join(dir, "VERSION");
  if (existsSync(vf)) return readFileSync(vf, "utf8").trim();
  const pj = join(dir, "package.json");
  if (existsSync(pj)) return JSON.parse(readFileSync(pj, "utf8")).version;
  throw new LrError("not_a_package", `${dir} is not a Looprch package (no VERSION file)`, "Run npm run build first, or pass the extracted npm package directory");
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function listVersions(): string[] {
  if (!existsSync(home.versions())) return [];
  return readdirSync(home.versions())
    .filter((n) => !n.includes(".tmp-") && existsSync(join(home.versions(), n, "VERSION")))
    .sort(compareSemver);
}

export function currentVersion(): string | null {
  const cur = home.current();
  try {
    if (!lstatSync(cur).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return basename(readlinkSync(cur));
}

function record(): InstallRecord {
  return readJsonIfExists<InstallRecord>(join(home.root(), "install.json")) ?? { current: currentVersion(), previous: null };
}

/** Atomically point `current` at versions/<v>: create a temp symlink and rename it over. */
export function switchCurrent(version: string): void {
  const target = home.version(version);
  if (!existsSync(target)) throw new LrError("version_missing", `Version ${version} is not installed in ${home.versions()}`);
  const before = currentVersion();
  const tmpLink = join(home.root(), `current.tmp-${process.pid}`);
  rmSync(tmpLink, { force: true });
  symlinkSync(join("versions", version), tmpLink);
  renameSync(tmpLink, home.current());
  const rec = record();
  writeJsonAtomic(join(home.root(), "install.json"), { current: version, previous: before && before !== version ? before : rec.previous });
}

export function previousVersion(): string | null {
  const prev = record().previous;
  return prev && existsSync(home.version(prev)) ? prev : null;
}

/** Copy a package directory into versions/<v> (verified). Returns the version. Idempotent. */
export function installVersion(srcDir: string): { version: string; reused: boolean } {
  const version = readVersionOf(srcDir);
  const srcCheck = verifyManifest(srcDir);
  if (!srcCheck.ok)
    throw new LrError("manifest_mismatch", `Package at ${srcDir} fails its manifest check (${srcCheck.error ?? `${srcCheck.mismatched.length + srcCheck.missing.length} files differ`})`, undefined, 1, srcCheck);
  ensureDir(home.versions());
  const target = home.version(version);
  if (existsSync(target)) {
    if (verifyManifest(target).ok) return { version, reused: true };
    rmSync(target, { recursive: true, force: true });
  }
  const tmpDir = `${target}.tmp-${process.pid}`;
  rmSync(tmpDir, { recursive: true, force: true });
  ensureDir(tmpDir);
  for (const entry of PACKAGE_ENTRIES) {
    const from = join(srcDir, entry);
    if (!existsSync(from)) throw new LrError("not_a_package", `Package is missing ${entry}`);
    cpSync(from, join(tmpDir, entry), { recursive: true, filter: (p) => !p.includes("__pycache__") });
  }
  const check = verifyManifest(tmpDir);
  if (!check.ok) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new LrError("manifest_mismatch", `Copied files fail the manifest check`, undefined, 1, check);
  }
  renameSync(tmpDir, target);
  return { version, reused: false };
}

/** Keep the newest `keep` versions plus current and previous. */
export function prune(keep = 2): string[] {
  const versions = listVersions();
  const protect = new Set([currentVersion(), previousVersion()].filter(Boolean) as string[]);
  const newest = versions.slice(-keep);
  const removed: string[] = [];
  for (const v of versions) {
    if (protect.has(v) || newest.includes(v)) continue;
    rmSync(home.version(v), { recursive: true, force: true });
    removed.push(v);
  }
  return removed;
}
