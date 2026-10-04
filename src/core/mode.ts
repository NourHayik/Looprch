import type { AgentId, Assignment, Mode } from "./config.js";
import { adapterFor, detectBinary } from "../agents/index.js";
import { locateRelay, relayInstallArgv, type RelayInfo } from "../delegate/locate.js";

export type ModeReason = "configured" | "d05_auto_delegate" | "quota_fallback" | "rate_limit_fallback" | "run_failed_fallback" | "unavailable_fallback" | "user_choice";

export type ModeResolution =
  | { ok: true; mode: Mode; reason: "configured" | "d05_auto_delegate"; relay: RelayInfo | null }
  | { ok: false; code: "relay_missing" | "cli_missing" | "delegate_unsupported"; reason: string; hint: string };

function delegateCheck(root: string, agent: AgentId, why: string): ModeResolution | RelayInfo {
  const a = adapterFor(agent);
  if (!a.delegate)
    return { ok: false, code: "delegate_unsupported", reason: `${a.displayName} has no delegate relay ${why}`, hint: `Run the Lead in ${a.displayName}, or assign this role to another agent with looprch config set-role` };
  const relay = locateRelay(root, agent);
  if (!relay) return { ok: false, code: "relay_missing", reason: `${a.delegate.skill} is not installed ${why}`, hint: `looprch install-relay ${agent}   (npx ${relayInstallArgv(agent).join(" ")})` };
  if (!detectBinary(a)) return { ok: false, code: "cli_missing", reason: `${a.displayName} CLI (${a.binaries.join(" or ")}) is not on PATH ${why}`, hint: `Install ${a.displayName}, or assign this role to another agent` };
  return relay;
}

/**
 * D-04/D-05: Direct runs natively only on its own host. Direct for another host runs through
 * that agent's relay with the same model; a missing relay or CLI stops with a clear message.
 */
export function resolveMode(root: string, a: Assignment, host: AgentId | null): ModeResolution {
  if (a.mode === "direct" && host === a.agent) return { ok: true, mode: "direct", reason: "configured", relay: null };
  const why = a.mode === "direct" ? `(the role is Direct on ${a.agent} but the Lead runs in ${host ?? "an unknown host"})` : "";
  const r = delegateCheck(root, a.agent, why.trim() ? why : "");
  if ("ok" in r) return r;
  return { ok: true, mode: "delegate", reason: a.mode === "direct" ? "d05_auto_delegate" : "configured", relay: r };
}
