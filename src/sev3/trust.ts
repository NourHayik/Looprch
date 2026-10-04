import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256File, verifySums } from "../install/manifest.js";
import { TOOL_FILES, vendorDir } from "./toolkit.js";

export interface TrustResult {
  trusted: boolean;
  mismatches: string[];
  extra_files: string[];
  lock_mismatch: boolean;
}

/** A package cannot self-authorize a modified reader: compare its tools with the vendored copy. */
export function checkToolkitTrust(root: string): TrustResult {
  const vendored = verifySums(vendorDir()).expected;
  const tools = join(root, "phases", "tools");
  const mismatches: string[] = [];
  for (const name of TOOL_FILES) {
    const p = join(tools, name);
    if (!existsSync(p)) mismatches.push(`phases/tools/${name} (missing)`);
    else if (sha256File(p) !== vendored[name]) mismatches.push(`phases/tools/${name}`);
  }
  const extra = existsSync(tools)
    ? readdirSync(tools)
        .filter((n) => n !== "__pycache__" && !(TOOL_FILES as readonly string[]).includes(n))
        .map((n) => `phases/tools/${n}`)
    : [];
  let lockMismatch = false;
  const lockPath = join(root, "phases", "tooling-lock.json");
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { version?: string; sha256?: Record<string, string> };
    for (const name of TOOL_FILES) if (lock.sha256?.[name] !== vendored[name]) lockMismatch = true;
  } catch {
    lockMismatch = true;
  }
  if (lockMismatch) mismatches.push("phases/tooling-lock.json");
  return { trusted: mismatches.length === 0, mismatches, extra_files: extra, lock_mismatch: lockMismatch };
}
