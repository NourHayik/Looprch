# Antigravity

- Binary: `agy`
- Skills: `.agents/skills/lr-*` (copied until symlink support is verified)
- Invoke: `/lr-init` (unverified)
- Direct: not supported in this version (the subagent file format is unverified); use Delegate.
- Delegate: `agy-delegate` relay. Session field `conversationId`, resumed with
  `--conversation`. Read-only is best effort: the relay reports `readOnlyViolation`, and Looprch
  also compares git status. Effort: `--effort`.
- QuotaLens provider: `antigravity`

## Permissions in phases

Headless `agy --print` cannot ask you to approve a tool, so it auto-denies every command that is
not on its allow list (for example `composer`, `php` or `npm test`). The run then fails with
"Antigravity auto-denied the command permission". To let Antigravity work as an Implementer or
Tester, Looprch passes `--dangerously-skip-permissions` to every **write** run (Implementer and
Tester). Antigravity then approves its own tool requests, which means **full access** to your
machine for that run. Read-only roles (Planner, Plan Debater, Reviewer, Worker) keep
`--read-only`, which runs agy in its sandbox. `looprch doctor` lists this as
`agent:agy:permissions`. Do not assign Antigravity to a write role if you do not accept this.

Looprch also passes the role timeout as agy's own `--print-timeout`. Without it, agy stops
itself after its default of 30 minutes, even when the role allows 2 hours.

## Login check

delegate-setup has no login probe for agy. When `agy models` lists models, the CLI is logged in,
so `looprch doctor` reports `agent:agy:auth` as `ok` ("agy models listed N models"). It warns
"authentication unknown" only when no model list is available.

## Notes

- Headless runs need one interactive login first: run `agy` once.
- Install the relay: `looprch install-relay agy`.
