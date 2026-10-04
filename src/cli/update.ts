import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LrError } from "../core/errors.js";
import { readJsonIfExists } from "../core/fsx.js";
import { home, projectPaths } from "../core/paths.js";
import type { State } from "../core/state.js";
import { currentVersion, installVersion, prune, switchCurrent } from "../install/central.js";
import { refreshRegisteredProjects } from "../install/links.js";
import { loadRegistry } from "../install/registry.js";
import { askConfirm } from "../ui/prompts.js";
import { parse } from "./args.js";
import { out } from "./output.js";

function fetchPackage(version: string | undefined): { dir: string; cleanup: () => void } {
  const target = version ?? execFileSync("npm", ["view", "looprch", "version"], { encoding: "utf8" }).trim();
  const tmp = mkdtempSync(join(tmpdir(), "looprch-update-"));
  execFileSync("npm", ["pack", `looprch@${target}`, "--pack-destination", tmp, "--silent"], { stdio: ["ignore", "pipe", "inherit"] });
  const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new LrError("download_failed", `npm pack looprch@${target} produced no tarball`);
  execFileSync("tar", ["xzf", join(tmp, tgz), "-C", tmp]);
  return { dir: join(tmp, "package"), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

export function projectsInProgress(): string[] {
  return loadRegistry()
    .filter((e) => existsSync(e.path))
    .filter((e) => {
      const s = readJsonIfExists<State>(projectPaths(e.path).state);
      return !!s?.current;
    })
    .map((e) => e.path);
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(
    argv,
    { to: { type: "string" }, from: { type: "string" }, yes: { type: "boolean", short: "y" } },
    "looprch update [--to <version>] [--from <package dir>] [--yes] [--json]",
  );
  const from = currentVersion();
  const busy = projectsInProgress();
  if (busy.length) {
    const ok = await askConfirm(`These projects have a phase in progress; the next phase step will pause until resumed if the protocol changes:\n  ${busy.join("\n  ")}\nUpdate anyway?`, !!values.yes);
    if (!ok) throw new LrError("cancelled", "Update cancelled");
  }
  const pkg = values.from ? { dir: resolve(values.from), cleanup: () => {} } : fetchPackage(values.to);
  try {
    const { version, reused } = installVersion(pkg.dir);
    const test = spawnSync(process.execPath, [join(home.version(version), "dist", "looprch.mjs"), "self-test", "--json"], { encoding: "utf8", env: process.env });
    if (test.status !== 0) {
      if (!reused && version !== from) rmSync(home.version(version), { recursive: true, force: true });
      throw new LrError("self_test_failed", `Self-test of ${version} failed; current version unchanged (${from ?? "none"})`, undefined, 1, test.stdout || test.stderr);
    }
    switchCurrent(version);
    const refreshed = refreshRegisteredProjects(loadRegistry());
    const pruned = prune(2);
    const data = { from, to: version, self_test: "ok", refreshed_projects: refreshed.map((r) => r.path), pruned };
    out(!!values.json, data, `Updated Looprch ${from ?? "(none)"} -> ${version}. Refreshed ${refreshed.length} project(s). Pruned: ${pruned.join(", ") || "none"}.`);
    return 0;
  } finally {
    pkg.cleanup();
  }
}
