# Looprch

Looprch runs a SEV3 project specification phase by phase with coding agents. SEV3 defines the
project; Looprch coordinates the Planner, Plan Debater, Implementer, Tester and Reviewer that
build and verify it, checks machine evidence for every gate, and keeps the execution state in
plain files inside your project.

Status: 0.4.0, on npm as [`looprch`](https://www.npmjs.com/package/looprch). Linux and macOS
(Windows through WSL).

## Quickstart

```sh
npx looprch@latest install                 # or: npx github:NourHayik/Looprch install
cd my-project                              # SEV3 package (phases/, requirements/) at the root
looprch add . --agents cursor,codex,opencode --yes
```

Then, inside your agent:

```text
/lr-init      # readiness, SEV3 trust, gate acknowledgement, roles and models
/lr-phase     # one phase: plan, debate, implement, test, review, handover, merge
/lr-auto      # all phases until the closure phase
/lr-finish    # closure phase and final report
```

From any terminal: `looprch status`, `looprch log`, `looprch doctor`.

## How it works

The `looprch` CLI owns a deterministic state machine. The agent you talk to (the Lead) asks
`looprch next` for exactly one action, performs it (start a subagent, dispatch a relay, run the
gates, commit a checkpoint, ask you a question) and reports back. A new chat, another agent or a
reboot simply continue. Roles run either as the host agent's own subagent (Direct) or through
another agent's CLI with [delegate-skills](https://github.com/amElnagdy/delegate-skills)
(Delegate). Every phase runs on a branch `looprch/P-NNN` and is merged and tagged when it closes.

## Documentation

- User guide: [docs/user/index.md](docs/user/index.md)
- Developer guide: [docs/dev/architecture.md](docs/dev/architecture.md)
- Contributing: [AGENTS.md](AGENTS.md), [docs/dev/contributing.md](docs/dev/contributing.md)

## License

MIT
