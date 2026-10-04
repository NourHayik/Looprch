---
name: lr-pause
description: Looprch - request a controlled pause; Looprch stops at the next step boundary and keeps all state. Use when the user runs /lr-pause.
---
# /lr-pause

Run `looprch pause --json`.

Tell the user: the pause takes effect at the next step boundary. A role that is already running
finishes and its result is recorded first; then `looprch next` answers `paused`. Nothing is lost.
To continue later: `/lr-resume`.

If you are currently running the `/lr-phase` or `/lr-auto` loop, finish the current step and stop
when `looprch next` answers `paused`.
