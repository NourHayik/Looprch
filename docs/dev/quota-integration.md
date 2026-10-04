# Quota integration

## Adapter (`src/quota/quotalens.ts`)

`readQuota()` runs `quotalens status --json` with a 30-second timeout and caches
`{at, data, error}` in `~/.looprch/cache/quota.json` for 60 seconds. Missing binary, non-zero
exit or unexpected JSON give `data: null` (unknown).

Observed schema 1.0 (2026-10-03): `providers[]` with `id`, `installed`, `auth_state`,
`usage_capability`, `status` (`ok`, `timeout`, ...), `stale`, `limits[]` with `id`, `category`
(`rolling_window`, `weekly`, `monthly`, `credit`, `other`), `remaining_percent` (may be null),
`resets_at`. Fixture: `test/fixtures/quotalens/status-2026-10-03.json`.

## Policy (`src/quota/policy.ts`)

- `providerVerdict(data, provider)`: unknown, stale or non-ok providers → ok. Exhausted limits are
  `remaining_percent === 0` in `rolling_window`, `weekly` or `monthly`; reset = the latest
  `resets_at` (null if any exhausted limit has none).
- `decide(verdict, now, quota_wait_minutes)`: attempt, wait (reset within the window) or fallback.
- `looksRateLimited(text)`: relay stderr/final message patterns.

## Use in the lifecycle

`issueRun` walks the role's assignments from the current fallback index: mode resolution, then
the quota choice. Fallbacks are recorded in `assignments_history` and `quota.fallback` events
(every assignment change, including failure fallbacks, also writes `assignment.changed`) and
stay in effect for the rest of the phase. Rate-limit failures set `state.quota.exhausted[provider]`
(source `rate_limit`, reset unknown); the mark is cleared after a successful run or when its
15-minute wait ends.

Provider ids per adapter: codex `codex`, cursor `cursor`, agy `antigravity`, kimi `kimi`,
opencode `opencode`; hermes and grok none.
