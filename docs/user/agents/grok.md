# Grok Build (experimental)

- Binary: `grok`
- Skills: `.grok/skills/lr-*` (copied)
- Invoke: `/lr-init` (unverified)
- Direct: not supported until verified.
- Delegate: `grok-delegate` relay. Session field `sessionId`, `--session`. Read-only is best
  effort (`--sandbox read-only` with `readOnlyViolation` reporting) plus Looprch's git check.
  Effort: `--effort`.
- QuotaLens provider: none

## Notes

- Grok Build ignores project skills until you trust the folder in Grok.
- Grok support is experimental: its verification spikes have not run (Grok was not installed
  when this version was built). `looprch doctor` shows this as a warning.
