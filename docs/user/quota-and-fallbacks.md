# Quota and fallbacks

Looprch reads usage limits from QuotaLens (`quotalens status --json`, schema 1.0, cached for 60
seconds in `~/.looprch/cache/quota.json`) before every role run, for every role. QuotaLens is
optional: without it every provider is treated as unknown and runs are attempted.

## The rule

- A limit counts as exhausted when `remaining_percent` is 0 in a `rolling_window`, `weekly` or
  `monthly` limit. Credit and other limits are ignored.
- Exhausted and the latest reset is within `limits.quota_wait_minutes` (default 60) → Looprch
  **waits** until the reset (`looprch next` answers `wait`; `looprch wait` sleeps in slices).
- Exhausted and the reset is later → the **next approved fallback** of the role is used (also
  checked). No fallback left → wait until the reset.
- QuotaLens missing, the provider unknown, stale or timed out → the run is attempted.

```sh
looprch config add-fallback implementer --mode delegate --agent codex --model <model>
looprch config set limits.quota_wait_minutes 30
```

## Rate-limit failures

If a relay fails with rate-limit wording (`rate limit`, `429`, `usage limit`, `too many
requests`), the provider is marked exhausted with an unknown reset: the next fallback runs, or
Looprch retries every 15 minutes. After four hours it asks you whether to keep waiting or pause.

## Switching the Implementer or Tester mid-phase

1. A checkpoint commit `agent switch (implementer opencode -> codex)` separates contributions.
2. The new agent starts a fresh session with the full packet, the approved plan, the diff since
   the phase base and the earlier final messages.
3. `state.json` records the assignment history; the handover lists every contributing
   implementer.

Provider ids: codex `codex`, cursor `cursor`, agy `antigravity`, kimi `kimi`, opencode
`opencode`. Hermes and Grok have no QuotaLens provider.

## Context-size guard

Set a budget per agent (`looprch config set context_kb.kimi 300`) or per role
(`--context-kb`). If a packet is larger and a fallback with a larger budget exists, Looprch asks
whether to continue or switch. Packets are never truncated.
