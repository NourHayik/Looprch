import type { QuotaData } from "./quotalens.js";

/** Only time-windowed limits count (OI-6): credit, other and null remaining are ignored. */
export const COUNTED_CATEGORIES = ["rolling_window", "weekly", "monthly"];

export type QuotaVerdict =
  | { kind: "ok"; reason: string }
  | { kind: "exhausted"; reset: string | null; limits: string[] };

/** Provider status from QuotaLens data. Unknown, stale or timed-out providers are allowed. */
export function providerVerdict(data: QuotaData | null, provider: string | undefined): QuotaVerdict {
  if (!provider) return { kind: "ok", reason: "agent has no QuotaLens provider" };
  if (!data) return { kind: "ok", reason: "QuotaLens unavailable" };
  const p = data.providers.find((x) => x.id === provider);
  if (!p) return { kind: "ok", reason: `provider ${provider} not reported` };
  if (p.stale || p.status !== "ok") return { kind: "ok", reason: `provider ${provider} is ${p.stale ? "stale" : p.status}` };
  const exhausted = p.limits.filter((l) => COUNTED_CATEGORIES.includes(l.category) && l.remaining_percent === 0);
  if (!exhausted.length) return { kind: "ok", reason: "limits available" };
  const resets = exhausted.map((l) => l.resets_at).filter((r): r is string => !!r);
  const reset = resets.length === exhausted.length ? resets.sort().at(-1)! : null;
  return { kind: "exhausted", reset, limits: exhausted.map((l) => l.id) };
}

export type QuotaDecision = { kind: "attempt" } | { kind: "wait"; until: string } | { kind: "fallback"; reset: string | null };

/** D-07: exhausted and the reset is within quota_wait_minutes → wait; otherwise use the next fallback. */
export function decide(verdict: QuotaVerdict, nowMs: number, waitMinutes: number): QuotaDecision {
  if (verdict.kind === "ok") return { kind: "attempt" };
  if (verdict.reset && Date.parse(verdict.reset) - nowMs <= waitMinutes * 60_000) return { kind: "wait", until: verdict.reset };
  return { kind: "fallback", reset: verdict.reset };
}

export const RATE_LIMIT_PATTERNS = [/rate[ _-]?limit/i, /\b429\b/, /quota (exceeded|exhausted)/i, /usage limit/i, /too many requests/i, /limit (reached|exceeded)/i];

export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}
