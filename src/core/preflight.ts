import type { AgentId, Config } from "./config.js";
import { validateConfig } from "./config.js";
import type { State } from "./state.js";
import { agentCaps } from "../agents/index.js";
import { locateRelay } from "../delegate/locate.js";
import { cachedModels } from "../delegate/discover.js";
import { resolveMode } from "./mode.js";
import { checkToolkitTrust } from "../sev3/trust.js";
import { packageFingerprint, verifyPackage } from "../sev3/fingerprint.js";
import { manifestSha } from "../sev3/discovery.js";

export type PreflightResult =
  | { ok: true; timings: Record<string, number> }
  | { ok: false; code: string; reason: string; hint: string; details?: unknown }
  | { ok: "ask_gates"; manifest_sha256: string };

function timed<T>(timings: Record<string, number>, name: string, fn: () => T): T {
  const t = Date.now();
  try {
    return fn();
  } finally {
    timings[name] = Date.now() - t;
  }
}

/** Lightweight checks before every phase (git checks run in the lifecycle after these pass). */
export function preflightChecks(root: string, cfg: Config, st: State, host: AgentId | null): PreflightResult {
  const timings: Record<string, number> = {};
  const v = timed(timings, "config", () => validateConfig(cfg, { caps: agentCaps(), relayExists: (a) => !!locateRelay(root, a), knownModels: (a) => cachedModels(a), requirePrimaryRoles: true }));
  if (!v.ok) return { ok: false, code: "config_invalid", reason: `Config is invalid: ${v.errors.join("; ")}`, hint: "Fix it with /lr-init or looprch config set-role ...", details: v.errors };
  if (!st.spec.package_fingerprint) return { ok: false, code: "not_initialized", reason: "The SEV3 package has not been discovered and verified yet", hint: "Run /lr-init (or: looprch init discover)" };
  const trust = timed(timings, "toolkit", () => checkToolkitTrust(root));
  if (!trust.trusted) return { ok: false, code: "toolkit_untrusted", reason: `The package toolkit differs from Looprch's trusted copy: ${trust.mismatches.join(", ")}`, hint: "A package cannot authorize a modified reader. Restore SEV3 toolkit 1.2.0 files." };
  const verify = timed(timings, "verify", () => verifyPackage(root));
  if (!verify.ok) return { ok: false, code: "spec_changed", reason: `The SEV3 package no longer verifies: ${verify.error}`, hint: "Looprch never re-imports automatically. Reseal an authorized amendment with SEV3, then run: looprch init discover --accept-fingerprint" };
  const fp = packageFingerprint(root);
  if (fp !== st.spec.package_fingerprint)
    return { ok: false, code: "spec_changed", reason: `The package fingerprint changed (${st.spec.package_fingerprint?.slice(0, 12)}… → ${fp.slice(0, 12)}…)`, hint: "Closed evidence is never rewritten. After reviewing the amendment run: looprch init discover --accept-fingerprint" };
  const sha = manifestSha(root);
  if (cfg.spec.gates_ack?.manifest_sha256 !== sha) return { ok: "ask_gates", manifest_sha256: sha };
  for (const [role, rc] of Object.entries(cfg.roles)) {
    if (!rc) continue;
    const m = timed(timings, `mode_${role}`, () => resolveMode(root, rc, host));
    if (!m.ok) return { ok: false, code: m.code, reason: `${role}: ${m.reason}`, hint: m.hint };
  }
  return { ok: true, timings };
}
