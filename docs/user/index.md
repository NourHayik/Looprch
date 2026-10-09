# Looprch

Looprch executes a software project phase by phase from a SEV3 specification, using the coding
agents you already have (Codex, Cursor, Antigravity, Kimi Code, OpenCode, Grok Build, with
Hermes as a Lead host).

- **SEV3** defines the project: requirements, contracts, phases, gates and `phases/todo.md`.
- **Looprch** executes it: for every phase it runs Planner ⇄ Plan Debater (a real debate over a
  guiding plan with a todo list) → Implementer (one run per plan session) → Tester → Reviewer →
  handover, checks machine evidence, commits on a phase branch and merges.
- **delegate-skills** is the transport Looprch uses when a role runs in another agent's CLI.

The `looprch` CLI owns a deterministic state machine. Your agent (the Lead) only asks
`looprch next` what to do, does it, and reports back. A new chat, another agent or a reboot
continue from the files in `.looprch/`.

## Start here

1. [Install](install.md)
2. [Quickstart](quickstart.md)
3. [Concepts](concepts.md)

## Guides

- [Attach a project](attach-a-project.md) · [/lr-init](lr-init.md) · [Roles and modes](roles-and-modes.md)
- [Running phases](running-phases.md) · [Status and logs](status-and-logs.md)
- [Handover and git](handover-and-git.md) · [Quota and fallbacks](quota-and-fallbacks.md) · [E2E testing](e2e-testing.md)
- [Update and rollback](update-and-rollback.md) · [Troubleshooting](troubleshooting.md)
- [Command reference](command-reference.md) · [Workflows and examples](workflows-and-examples.md) · [FAQ](faq.md)

## Agents

[Codex](agents/codex.md) · [Cursor](agents/cursor.md) · [Antigravity](agents/antigravity.md) ·
[Kimi Code](agents/kimi.md) · [Hermes](agents/hermes.md) · [OpenCode](agents/opencode.md) ·
[Grok Build](agents/grok.md)

Developer documentation: [docs/dev/architecture.md](../dev/architecture.md).
