import type { AgentId, Mode } from "../core/config.js";
import { nowIso } from "../core/clock.js";
import type { State } from "../core/state.js";

/** Sessions are keyed per (phase, role, agent); each phase starts fresh sessions. */
export function sessionKey(phase: string, role: string, agent: AgentId): string {
  return `${phase}/${role}/${agent}`;
}

export function resumableSession(st: State, key: string): string | null {
  const s = st.sessions[key];
  return s?.session_id && s.resumable ? s.session_id : null;
}

export function recordSession(st: State, key: string, sessionId: string | null, mode: Mode, resumable: boolean, runId: string): void {
  const prev = st.sessions[key];
  const at = nowIso();
  st.sessions[key] = {
    session_id: sessionId ?? prev?.session_id ?? null,
    mode,
    resumable: !!sessionId && resumable,
    created_at: prev && prev.session_id === sessionId ? prev.created_at : at,
    last_used: at,
    runs: [...(prev?.runs ?? []), runId],
  };
}

/** A resume that came back with a different (or no) session id means context was not retained. */
export function forgetSession(st: State, key: string): void {
  const s = st.sessions[key];
  if (s) s.resumable = false;
}
