import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, writeExecutable, type Sandbox } from "./tmp.js";

export const RELAY_AGENTS = ["codex", "cursor", "agy", "kimi", "opencode", "grok"] as const;

/** Fake relays in ~/.agents/skills/<agent>-delegate and fake agent binaries on PATH. */
export function installFakes(s: Sandbox, agents: readonly string[] = RELAY_AGENTS): void {
  for (const a of agents) {
    const dir = join(s.home, ".agents", "skills", `${a}-delegate`);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(join(FIXTURES, "fake-relay", "relay.mjs"), join(dir, "scripts", "relay.mjs"));
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${a}-delegate\nmetadata:\n  version: 0.5.0\n---\nFake relay for tests.\n`);
  }
  const bins: Record<string, string> = { codex: "codex", cursor: "cursor-agent", agy: "agy", kimi: "kimi", opencode: "opencode", grok: "grok", hermes: "hermes" };
  for (const a of agents) writeExecutable(join(s.bin, bins[a]!), `#!/bin/sh\necho "fake ${a} 1.0.0"\n`);
  writeExecutable(join(s.bin, "quotalens"), `#!/bin/sh\nif [ -n "$FAKE_QUOTA_FILE" ] && [ -f "$FAKE_QUOTA_FILE" ]; then cat "$FAKE_QUOTA_FILE"; else echo "quotalens: no data" >&2; exit 1; fi\n`);
}

export function quotaJson(providers: { id: string; remaining: number | null; resets_at: string | null; category?: string; status?: string; stale?: boolean }[]): string {
  return JSON.stringify({
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    fresh: true,
    providers: providers.map((p) => ({
      id: p.id,
      installed: true,
      auth_state: "authenticated",
      usage_capability: "supported",
      status: p.status ?? "ok",
      stale: p.stale ?? false,
      limits: [{ id: "primary", category: p.category ?? "rolling_window", remaining_percent: p.remaining, resets_at: p.resets_at }],
    })),
  });
}
