# Prompt for Plan Mode: Looprch implementation plan

Copy everything below the line into a new chat in Plan mode, opened in this folder.

---

You are a senior developer-tooling architect. Write the implementation plan for **Looprch**, a
local CLI plus an agent-skill bundle. Looprch orchestrates coding agents phase by phase from a
SEV3-generated project specification. The architecture has already been researched, challenged
and agreed with me. Your job is to turn it into an executable, phase-by-phase implementation
plan. Do not redesign it.

## Read these completely before planning

1. `research/00_README.md`: start here. It contains the decision log (D-01 to D-22), which is
   binding.
2. `research/01_architecture.md` through `research/09_risks_spikes_testing_docs.md`.
3. `looprch_core_requirements.md` and `looprch_commands_and_integrations_en_v2.md`: the
   original requirements. Where they differ from `research/`, `research/` wins.
4. `looprch_enhancement_ideas_en.md`: include every idea marked **Now**, and exclude the ones
   marked **Later**.
5. `sev3/`: the READ-ONLY SEV3 skill. Read `SKILL.md`, `references/package-contract.md`,
   `references/context-design.md`, `assets/package/phases/*.md`, `assets/manifest.schema.json`
   and the example package `examples/notes-spec/`. Never plan any change to SEV3.
6. `sev3_observations_for_review.md`: context only. It creates no tasks.

The external tools you may inspect are the installed delegate-skills relays
(`~/.agents/skills/*-delegate/scripts/relay.mjs`, `~/.agents/skills/delegate-setup/`) and
`quotalens status --json`. Inspect them read-only, and do not run any delegate relay.

## Hard constraints

- Follow every decision in the decision log. If you find a genuine contradiction or a blocking
  gap, list it under "Open issues" at the top of the plan with your proposed resolution, rather
  than silently changing the design.
- Do not over-engineer:
  - No SQLite, daemon, server, MCP server or plugin framework.
  - No runtime dependencies beyond `@clack/prompts` (bundled).
  - Each module must map to a component in `research/01_architecture.md`.
- Keep the shared core strictly separate from project-local state. Every command must be
  idempotent.
- Treat SEV3 as read-only. Vendor its toolkit 1.2.0 byte-for-byte.
- Linux and macOS only (Windows via WSL). English documentation only.
- Do not invent model ids, CLI flags or file paths. Where `research/` marks something
  UNVERIFIED, plan a verification spike before the dependent work, and give a fallback.

## Required plan structure

1. **Summary**: scope of v1, what is explicitly out of scope, and the open issues, if any.
2. **Implementation phases** (follow the suggested build order in `research/09` §6 unless you
   justify a change). For each phase:
   - Objective, plus the decision IDs and requirement sections it implements.
   - The exact files and directories to create or modify, using the repository layout in
     `research/01` §5.
   - Interfaces, schemas and CLI JSON outputs it defines (with field names).
   - Step-by-step tasks, small enough that another coding agent can execute each one without
     reinterpreting the architecture.
   - Tests to write (unit, integration or e2e), with named cases, including the failure paths.
   - Documentation pages to write or update (`docs/user/…`, `docs/dev/…`).
   - Acceptance criteria that are objectively checkable, with the exact commands.
   - Dependencies on earlier phases, and the risks this phase addresses.
3. **Verification spikes** (`research/09` §2): for each spike, the procedure, the expected
   evidence, and how its result changes the adapters or modes.
4. **Cross-cutting specifications**, written out in full:
   - the `config.json`, `state.json`, `events.jsonl` and `gates.json` schemas;
   - the role result block schema;
   - the brief template structure;
   - the `looprch next` action schema and the complete transition table of the phase state
     machine, including repair loops, the cap, pause, wait, blocked, the quota fallback and
     interruption recovery.
5. **Agent adapter table**: for Codex, Cursor, Antigravity, Kimi Code, Hermes, OpenCode and Grok
   Build, the exact files each one generates, its invocation syntax, Direct support and Delegate
   capabilities. Mark every UNVERIFIED item as gated by a spike.
6. **Test matrix and the e2e scenario** on SEV3 `notes-spec`, run with fake relays.
7. **Documentation deliverables**: every page in `research/09` §4 with a one-line outline.
8. **Release checklist**: an unpublished v0.1.0, `npm pack`, `install.sh`, CHANGELOG, a local
   git tag.

The plan must be detailed enough for another coding agent to implement Looprch phase by phase
without asking architecture questions. Before writing the plan, list any questions that truly
need my decision, and keep them to a minimum.
