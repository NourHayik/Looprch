# Antigravity

- Binary: `agy`
- Skills: `.agents/skills/lr-*` (copied until symlink support is verified)
- Invoke: `/lr-init` (unverified)
- Direct: not supported in this version (the subagent file format is unverified); use Delegate.
- Delegate: `agy-delegate` relay. Session field `conversationId`, resumed with
  `--conversation`. Read-only is best effort: the relay reports `readOnlyViolation`, and Looprch
  also compares git status. Effort: `--effort`.
- QuotaLens provider: `antigravity`

## Notes

- Headless runs need one interactive login first: run `agy` once.
- Install the relay: `looprch install-relay agy`.
