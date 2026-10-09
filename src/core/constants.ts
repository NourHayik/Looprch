import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __LOOPRCH_VERSION__: string | undefined;

export const PROTOCOL = 5;
export const TOOLKIT_VERSION = "1.2.0";
export const CONFIG_SCHEMA = 1;
export const STATE_SCHEMA = 1;
export const SEV3_SCHEMA = "sev3/1";

/** npm spec used while the package is not on the npm registry (npm builds it via `prepare`). */
export const GITHUB_SPEC = "github:NourHayik/Looprch";

export const SKILLS = [
  "lr-init",
  "lr-doctor",
  "lr-status",
  "lr-phase",
  "lr-auto",
  "lr-pause",
  "lr-resume",
  "lr-review",
  "lr-finish",
  "lr-worker",
  "lr-e2e-test-init",
] as const;

export const ROLES = ["planner", "plan_debater", "implementer", "tester", "reviewer", "worker"] as const;
export type Role = (typeof ROLES)[number];
export const PRIMARY_ROLES: Role[] = ["planner", "plan_debater", "implementer", "tester", "reviewer"];
/** Roles that run in the agent's read-only mode: the advisory Worker only; phase roles have no file restrictions. */
export const READ_ONLY_ROLES: Role[] = ["worker"];

/** Directory that contains assets/ and vendor/ (repo checkout, npm package or installed version). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "assets", "skills")) && existsSync(join(dir, "vendor"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Cannot locate the Looprch package root (assets/ and vendor/ not found)");
}

function readVersion(): string {
  if (typeof __LOOPRCH_VERSION__ !== "undefined") return __LOOPRCH_VERSION__;
  const root = packageRoot();
  const versionFile = join(root, "VERSION");
  if (existsSync(versionFile)) return readFileSync(versionFile, "utf8").trim();
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

export const VERSION = readVersion();
