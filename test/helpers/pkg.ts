import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { REPO, tmp } from "./tmp.js";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "__pycache__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function writeManifest(dir: string): void {
  const files = ["dist", "assets", "vendor", "schemas"].flatMap((d) => walk(join(dir, d)));
  files.push(join(dir, "VERSION"));
  const lines = files
    .map((f) => relative(dir, f).split(sep).join("/"))
    .sort()
    .map((rel) => `${createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex")}  ${rel}`);
  writeFileSync(join(dir, "MANIFEST.sha256"), `${lines.join("\n")}\n`);
}

/** A copy of the built package with another version number (and optional tampering before the manifest is written). */
export function makePackage(version: string, tamper?: (dir: string) => void): string {
  const dir = join(tmp("lr-pkg-"), "package");
  for (const e of ["dist", "assets", "vendor", "schemas"]) cpSync(join(REPO, e), join(dir, e), { recursive: true });
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  const bundle = join(dir, "dist", "looprch.mjs");
  writeFileSync(bundle, readFileSync(bundle, "utf8").replace(/"0\.1\.0"/g, JSON.stringify(version)));
  tamper?.(dir);
  writeManifest(dir);
  return dir;
}
