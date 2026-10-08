import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "../core/runs.js";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function lines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a partial last line of a killed relay
    }
  }
  return out;
}

/**
 * Token usage as the relay wrote it, or null. Formats seen in delegate-skills relays:
 * cursor `result.json` `usage` {inputTokens, outputTokens, cacheReadTokens}; codex
 * `events.jsonl` `turn.completed.usage` {input_tokens, cached_input_tokens, output_tokens}
 * (input includes the cached part); opencode `events.jsonl` per step `part.tokens`
 * {input, output, reasoning, cache.read}. Nothing is estimated.
 */
export function readRelayUsage(outDir: string): Usage | null {
  const resultPath = join(outDir, "result.json");
  if (existsSync(resultPath)) {
    try {
      const r = JSON.parse(readFileSync(resultPath, "utf8")) as { usage?: Record<string, unknown> };
      if (r.usage && typeof r.usage === "object" && ("inputTokens" in r.usage || "outputTokens" in r.usage))
        return { input: num(r.usage.inputTokens), cached_input: num(r.usage.cacheReadTokens), output: num(r.usage.outputTokens), source: "result.usage" };
    } catch {
      // fall through to the events file
    }
  }
  const events = lines(join(outDir, "events.jsonl"));
  let turn: Record<string, unknown> | null = null;
  const steps = { input: 0, cached: 0, output: 0, seen: false };
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, unknown>;
    if (e.type === "turn.completed" && e.usage && typeof e.usage === "object") turn = e.usage as Record<string, unknown>;
    const part = e.part as Record<string, unknown> | undefined;
    const t = part && typeof part === "object" ? (part.tokens as Record<string, unknown> | undefined) : undefined;
    if (t && typeof t === "object") {
      steps.seen = true;
      steps.input += num(t.input);
      steps.output += num(t.output) + num(t.reasoning);
      steps.cached += num((t.cache as Record<string, unknown> | undefined)?.read);
    }
  }
  if (turn) {
    const cached = num(turn.cached_input_tokens);
    return { input: Math.max(0, num(turn.input_tokens) - cached), cached_input: cached, output: num(turn.output_tokens), source: "events.turn.completed" };
  }
  if (steps.seen) return { input: steps.input, cached_input: steps.cached, output: steps.output, source: "events.part.tokens" };
  return null;
}
