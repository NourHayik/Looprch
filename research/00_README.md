# Looprch research and decisions (input for implementation planning)

Date: 2026-10-03. Status: architecture agreed with the user; implementation plan not yet written.

This folder is the agreed architecture for the new Looprch. Use it together with:

- `../looprch_core_requirements.md` (what Looprch must do)
- `../looprch_commands_and_integrations_en_v2.md` (commands and SEV3 / delegate-skills relationship)
- `../looprch_enhancement_ideas_en.md` (accepted enhancements, marked "now" or "later")
- `../sev3/` (READ-ONLY SEV3 skill; defines the package Looprch consumes; never modify it)

Where this folder and the two requirement files disagree, this folder wins: it records decisions
taken after reviewing those requirements. Every such change is listed in the decision log below.

## Files

| File | Contents |
|---|---|
| `01_architecture.md` | Boundaries, core design (step engine), components, Looprch repository layout |
| `02_install_and_update.md` | npm + install.sh, central layout, shim, update, rollback, migrations, versioning |
| `03_project_attachment_and_agents.md` | `looprch add .`, symlink/copy strategy, per-agent adapters and facts |
| `04_roles_modes_delegate_quota.md` | Roles, Direct vs Delegate, delegate-skills, sessions, QuotaLens policy |
| `05_sev3_integration.md` | Discovery, trust, packets, gates and evidence, todo.md, handovers |
| `06_lifecycle_state_commands.md` | Phase state machine, project state files, commands, bootstrap, preflight |
| `07_git_strategy.md` | git init, baseline, per-phase branches, checkpoints, merge, tags |
| `08_tool_evaluation.md` | Researched tools classified RECOMMENDED / OPTIONAL / NOT NEEDED |
| `09_risks_spikes_testing_docs.md` | Risks, required verification spikes, testing strategy, docs plan, out of scope |

## Decision log

"User" = decided by the user in discussion. "Rec" = architect recommendation accepted with the findings.

| ID | Decision | Source |
|---|---|---|
| D-01 | Fresh, small rewrite. Looprch 5.x (`../../looprch-sev3-5.1.0`) and `looprch-cursor-native` are reference only. No migration of Corebit or any 5.x `.looprch/` state. | User |
| D-02 | The `looprch` CLI owns a deterministic state machine (`looprch next` / `looprch record`). The host agent (Lead) executes one step at a time and keeps no workflow state in its context. | Rec |
| D-03 | Plain JSON files plus an append-only JSONL journal, atomic writes, one lock file. No SQLite, tickets, operator keys, daemon, server or MCP server. | Rec |
| D-04 | Direct = the agent the Lead runs in executes the role as its own native subagent; the user chooses only the model. Delegate = another agent CLI runs the role through delegate-skills; the user chooses agent + model. | User |
| D-05 | If a role is Direct for host X but the Lead now runs in host Y, Looprch automatically runs that role through `X-delegate` with the same model and shows this in status. If no relay or CLI exists for X, it stops with a clear message. | User |
| D-06 | Role → agent/model/mode is configured conversationally inside `/lr-init` and persisted through validated CLI calls. `looprch add .` (shell TUI) selects agents and installs integrations. | User |
| D-07 | QuotaLens is in v1. For EVERY role (including Implementer and Tester): if a limit is exhausted and resets in 60 minutes or less, wait; otherwise switch to the next approved fallback. | User |
| D-08 | Single sequential Implementer (SEV3 rule). Parallel Implementers deferred. Parallel read-only Workers allowed, capped. | User |
| D-09 | Worker is read-only and advisory in v1. | User |
| D-10 | Linux and macOS in v1. Windows via WSL only. | User |
| D-11 | Git: before first phase `git init -b main` if needed and a clean baseline. Each phase runs on branch `looprch/P-NNN` from the recorded base branch, with stage checkpoint commits, then `merge --no-ff` into base, tag `looprch/P-NNN`, delete branch. No remote required. | User + Rec |
| D-12 | Distribution: npm package `looprch` (name free on 2026-10-03) as the only channel; `install.sh` for `curl | sh` just checks prerequisites and runs the same npx command. | Rec |
| D-13 | Central install: `~/.looprch/versions/<v>/`, `~/.looprch/current` symlink, shim `~/.local/bin/looprch`. Projects reference `~/.looprch/current`, never the npx cache or an nvm path. | Rec |
| D-14 | Symlinks only for static skill folders; gitignored. Files containing project data (model names) are generated. Copy mode with version stamp for agents that do not follow symlinks and for WSL edge cases. | Rec |
| D-15 | Model choice has one source of truth: `.looprch/config.json`. delegate-skills "lanes" are not used; Looprch passes explicit `--model` / `--effort` flags. | Rec |
| D-16 | SEV3 package must be at the project root in v1 (SEV3 tools only write under `<root>/.looprch/`; gate paths assume it). | Rec |
| D-17 | Looprch vendors SEV3 toolkit 1.2.0 byte-for-byte and always runs its own copy after comparing hashes. | SEV3 contract |
| D-18 | `/lr-auto` runs phases until the `kind: closure` phase and stops; `/lr-finish` runs the closure phase and final project closure. | Rec |
| D-19 | Implementation language: TypeScript compiled with `tsc` (type check) and bundled to one ESM file with esbuild. Runtime: Node 22+, Python 3.10+ (SEV3 toolkit only), git. One bundled runtime dependency: `@clack/prompts`. | Rec |
| D-20 | User and developer documentation in English only. | User |
| D-21 | The Looprch source folder (`Looprch-4`) is a local git repository on `main`, no remote. | User |
| D-22 | SEV3 observations are recorded separately in `../sev3_observations_for_review.md`; SEV3 is not changed. | User |
| D-23 | The approved plan carries a machine-checked phase contract (`contract.json`: obligations and deferrals). Looprch checks that it covers every mapped requirement, that debate findings are dispositioned, and that the Tester's verifications and the Reviewer's `contract_review` cover it; the Tester's claimed testcases must pass in Looprch's own gate run. Plan, Implementer, Tester and Reviewer share one contract instead of four readings of the plan. | CoreBit P-001 evidence (0.5.0) |
| D-24 | Review findings carry a `cause`; findings form lineages (`related`, a Fix that never changes). Design causes, repeated (`unfixed`, `related`) and `needs_design` findings go to a Planner repair design (a contract amendment) before the Implementer; serious or repeated designs get one Plan Debater challenge. No new stage, role or review round. | CoreBit P-001 evidence (0.5.0) |
| D-25 | The expensive model designs, the cheaper model executes. The contract carries work packages (exact files, contents, signatures, ordered steps, done_when checks; bounded size) that cover every obligation, and the Implementer runs once per package. Every review round's Implementer findings become Planner repair packages (at most 5 findings each), executed one per run. Protocol 3. | User goal + CoreBit P-001 evidence (0.6.0) |

## Lessons from earlier builds (evidence, not code to port)

Looprch 5.x (in Corebit at 5.3.2) had a 1,529-line installer, a 1,036-line kernel, SQLite control
state, run tickets and an operator key. Corebit is still stuck in P-001 planning; its SQLite state
points to a checkpoint branch that does not exist; four backup copies of Corebit are named after
blocked attempts (`blocked-p001-baseline`, `plan-kimi`, `setup-before-model-choice`). Its own review
found: Workers inheriting environment secrets, a JUnit file with declared failures counted as a
pass, and the checkpoint commit not including the ticked TODO.

Keep: role separation, machine-evidence gates, exact-source packets, handover headings, the
idea of a trusted toolkit copy, role prompt wording (as reference).

Drop: SQLite, tickets/operator keys, "Lead governance" prompts as the only state keeper,
protected-dirty-file machinery (replaced by a clean baseline), the heavy installer, helper
snapshot machinery.
