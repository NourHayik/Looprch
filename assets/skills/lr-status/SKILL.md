---
name: lr-status
description: Looprch - show what Looprch is doing now and what happens next (current phase, stage, active role and agent, blockers). Use when the user runs /lr-status.
---
# /lr-status

Run `looprch status --json` and explain it in a few lines:
- project, phases closed out of total,
- current phase, stage and repair round (or that no phase is in progress),
- the active run: role, agent, mode (`direct→delegate` means a Direct role is running through its
  relay because the Lead is in another host), how long it has run,
- the last result,
- blockers (`flags.blocked` with its `hint`, a pause, a wait) and the pending question if any,
- the next expected action (`next.summary`).

For history, `looprch log -n 20` shows the latest journal events. Change nothing.
