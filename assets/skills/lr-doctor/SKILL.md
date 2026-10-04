---
name: lr-doctor
description: Looprch - check whether the Looprch environment for this project is ready (tools, agents, relays, QuotaLens, SEV3 package, git, roles) and explain the result. Use when the user runs /lr-doctor.
---
# /lr-doctor

Run `looprch doctor --json` (add `--quick` only if the user asks for a fast check).

Report to the user:
- first the overall `ok`,
- then every check with status `fail`, each with its `summary` and the exact `fix` command,
- then the `warn` checks, briefly,
- skip the `ok` checks unless the user asks.

Offer to run fixes that are `looprch` commands (for example `looprch install-relay codex --yes`)
only after the user agrees. Never edit `.looprch/` files yourself.
