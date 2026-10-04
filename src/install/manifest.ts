import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface ManifestCheck {
  ok: boolean;
  files: number;
  missing: string[];
  mismatched: string[];
  error: string | null;
}

/** Verify `<dir>/MANIFEST.sha256` (lines of "<sha256>  <relpath>"). */
export function verifyManifest(dir: string): ManifestCheck {
  const file = join(dir, "MANIFEST.sha256");
  if (!existsSync(file)) return { ok: false, files: 0, missing: [], mismatched: [], error: `No MANIFEST.sha256 in ${dir}` };
  const missing: string[] = [];
  const mismatched: string[] = [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) return { ok: false, files: 0, missing, mismatched, error: `Malformed manifest line: ${line}` };
    const path = join(dir, m[2]!);
    if (!existsSync(path)) missing.push(m[2]!);
    else if (sha256File(path) !== m[1]) mismatched.push(m[2]!);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, files: lines.length, missing, mismatched, error: null };
}

/** Verify a `sha256sum`-style file listing names relative to its directory. */
export function verifySums(dir: string, sumsFile = "SHA256SUMS"): { ok: boolean; expected: Record<string, string>; mismatched: string[] } {
  const expected: Record<string, string> = {};
  const mismatched: string[] = [];
  for (const line of readFileSync(join(dir, sumsFile), "utf8").split("\n")) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trim());
    if (!m) continue;
    expected[m[2]!] = m[1]!;
    const p = join(dir, m[2]!);
    if (!existsSync(p) || sha256File(p) !== m[1]) mismatched.push(m[2]!);
  }
  return { ok: mismatched.length === 0 && Object.keys(expected).length > 0, expected, mismatched };
}
