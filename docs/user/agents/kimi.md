# Kimi Code

- Binary: `kimi` (Kimi Code 2.x; the old `kimi-cli` is archived)
- Skills: `.agents/skills/lr-*` (copied until symlink support is verified)
- Invoke: `/skill:lr-init`, `/skill:lr-phase`, ...
- Direct: not supported in this version; use Delegate.
- Delegate: `kimi-delegate` relay. Session field `sessionId`, `--session`. **No read-only
  mode** and no effort flag: assigning Kimi to Plan Debater, Reviewer or Worker shows a warning,
  and Looprch blocks the run if git status changes.
- QuotaLens provider: `kimi` (often reported as timed out or stale, which Looprch treats as
  unknown)

## Notes

- `kimi` does not list its models through discovery; type the alias you use.
- Install the relay: `looprch install-relay kimi`.
