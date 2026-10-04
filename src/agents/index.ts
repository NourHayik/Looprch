import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, type AgentCaps, type AgentId } from "../core/config.js";
import { agy } from "./agy.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { grok } from "./grok.js";
import { hermes } from "./hermes.js";
import { kimi } from "./kimi.js";
import { opencode } from "./opencode.js";
import type { AgentAdapter } from "./types.js";

export const ADAPTERS: Record<AgentId, AgentAdapter> = { codex, cursor, agy, kimi, hermes, opencode, grok };

export function adapterFor(id: AgentId): AgentAdapter {
  return ADAPTERS[id];
}

export function allAdapters(): AgentAdapter[] {
  return AGENT_IDS.map((id) => ADAPTERS[id]);
}

export function agentCaps(): Record<AgentId, AgentCaps> {
  const out = {} as Record<AgentId, AgentCaps>;
  for (const a of allAdapters()) {
    out[a.id] = {
      direct: !!a.direct,
      delegate: !!a.delegate,
      readOnly: a.delegate?.readOnly ?? "none",
      ...(a.delegate?.modelFormat ? { modelFormat: a.delegate.modelFormat } : {}),
    };
  }
  return out;
}

export function which(binary: string, pathEnv = process.env.PATH ?? ""): string | null {
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const full = join(dir, binary);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function detectBinary(adapter: AgentAdapter): { binary: string; path: string } | null {
  for (const b of adapter.binaries) {
    const p = which(b);
    if (p) return { binary: b, path: p };
  }
  return null;
}

/** Hosts whose environment markers are present. Hints only; the skill declares --host. */
export function detectHosts(env: NodeJS.ProcessEnv = process.env): AgentId[] {
  return allAdapters()
    .filter((a) => a.envMarkers.some((m) => env[m] !== undefined && env[m] !== ""))
    .map((a) => a.id);
}
