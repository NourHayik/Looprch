import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../helpers/tmp.js";
import { decide, looksRateLimited, providerVerdict } from "../../src/quota/policy.js";
import type { QuotaData } from "../../src/quota/quotalens.js";

const NOW = Date.parse("2026-10-03T20:00:00Z");
const data = (limits: any[], extra: any = {}): QuotaData => ({ schema_version: "1.0", generated_at: "", providers: [{ id: "opencode", status: "ok", stale: false, limits, ...extra }] });

describe("quota policy", () => {
  test("captured QuotaLens output parses; stale/timeout providers are unknown", () => {
    const d = JSON.parse(readFileSync(join(REPO, "test/fixtures/quotalens/status-2026-10-03.json"), "utf8")) as QuotaData;
    assert.deepEqual(d.providers.map((p) => p.id), ["codex", "kimi", "antigravity", "cursor", "opencode"]);
    assert.equal(providerVerdict(d, "kimi").kind, "ok");
    assert.match((providerVerdict(d, "kimi") as any).reason, /stale|timeout/);
    assert.equal(providerVerdict(d, "codex").kind, "ok");
  });

  test("no data or no provider means attempt", () => {
    assert.equal(decide(providerVerdict(null, "codex"), NOW, 60).kind, "attempt");
    assert.equal(decide(providerVerdict(data([]), undefined), NOW, 60).kind, "attempt");
  });

  test("exhausted with reset in 30 minutes waits", () => {
    const v = providerVerdict(data([{ id: "5h", category: "rolling_window", remaining_percent: 0, resets_at: "2026-10-03T20:30:00Z" }]), "opencode");
    assert.deepEqual(decide(v, NOW, 60), { kind: "wait", until: "2026-10-03T20:30:00Z" });
  });

  test("exhausted with reset in 3 hours falls back", () => {
    const v = providerVerdict(data([{ id: "w", category: "weekly", remaining_percent: 0, resets_at: "2026-10-03T23:00:00Z" }]), "opencode");
    assert.equal(decide(v, NOW, 60).kind, "fallback");
  });

  test("the latest reset of several exhausted limits is used", () => {
    const v = providerVerdict(
      data([
        { id: "a", category: "rolling_window", remaining_percent: 0, resets_at: "2026-10-03T20:10:00Z" },
        { id: "b", category: "monthly", remaining_percent: 0, resets_at: "2026-10-03T22:00:00Z" },
      ]),
      "opencode",
    );
    assert.equal(decide(v, NOW, 60).kind, "fallback");
  });

  test("credit, other and null remaining are ignored", () => {
    const v = providerVerdict(
      data([
        { id: "c", category: "credit", remaining_percent: 0, resets_at: null },
        { id: "o", category: "other", remaining_percent: 0, resets_at: null },
        { id: "n", category: "weekly", remaining_percent: null, resets_at: null },
      ]),
      "opencode",
    );
    assert.equal(v.kind, "ok");
  });

  test("exhausted without a reset time falls back (unknown reset)", () => {
    const v = providerVerdict(data([{ id: "x", category: "weekly", remaining_percent: 0, resets_at: null }]), "opencode");
    assert.deepEqual(decide(v, NOW, 60), { kind: "fallback", reset: null });
  });

  test("rate-limit classification", () => {
    assert.ok(looksRateLimited("Error: 429 Too Many Requests"));
    assert.ok(looksRateLimited("You have hit your usage limit"));
    assert.ok(!looksRateLimited("TypeError: undefined is not a function"));
  });
});
