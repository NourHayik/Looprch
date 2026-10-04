import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LrError } from "../core/errors.js";
import { runTool } from "./toolkit.js";

export interface VerifyResult {
  ok: boolean;
  phase_count: number | null;
  requirement_count: number | null;
  semantic_translation_verified: boolean;
  application_verified: boolean;
  error: string | null;
  ms: number;
}

/** The vendored verify_package.py is the authority (OI-2): it validates sources, locks and views. */
export function verifyPackage(root: string): VerifyResult {
  const r = runTool("verify_package.py", ["--root", root]);
  const j = r.json ?? {};
  const ok = r.code === 0 && j.ok === true;
  return {
    ok,
    phase_count: typeof j.phase_count === "number" ? j.phase_count : null,
    requirement_count: typeof j.requirement_count === "number" ? j.requirement_count : null,
    semantic_translation_verified: j.semantic_translation_verified === true,
    application_verified: j.application_verified === true,
    error: ok ? null : String(r.errorJson?.error ?? (r.stderr.trim() || "verification failed")),
    ms: r.ms,
  };
}

/** Package fingerprint: phases/package-lock.json → fingerprint, meaningful only after verify passed (OI-1). */
export function packageFingerprint(root: string): string {
  try {
    const lock = JSON.parse(readFileSync(join(root, "phases", "package-lock.json"), "utf8")) as { fingerprint?: string };
    if (!lock.fingerprint) throw new Error("no fingerprint field");
    return lock.fingerprint;
  } catch (err) {
    throw new LrError("spec_lock_invalid", `Cannot read phases/package-lock.json fingerprint: ${(err as Error).message}`);
  }
}

/** Source fingerprint: `specctl.py fingerprint` (sources only; generated views and todo excluded). */
export function sourceFingerprint(root: string): string {
  const r = runTool("specctl.py", ["fingerprint", "--root", root]);
  const fp = r.json?.source_fingerprint;
  if (r.code !== 0 || typeof fp !== "string") throw new LrError("toolkit_failed", `specctl.py fingerprint failed: ${String(r.errorJson?.error ?? r.stderr.trim())}`);
  return fp;
}
