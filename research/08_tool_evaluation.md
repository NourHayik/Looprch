# 08 — Tool evaluation

Research dated 2026-09-30 (GitHub API / npm registry), local checks 2026-10-03.

## RECOMMENDED

**delegate-skills** — https://github.com/amElnagdy/delegate-skills (relays 0.5.0 installed)
- Problem solved: headless invocation of each agent CLI with sessions, read-only modes, timeouts and a uniform `result.json`.
- Better than in-house: each CLI has its own flags and quirks, which the project already handles and maintains.
- Complexity: Low (Looprch calls `relay.mjs` by path).
- Maintained: yes. Needed: yes, for Delegate mode. Works without it: Direct-only.

**SEV3 toolkit 1.2.0 (vendored)** — `../sev3/assets/package/phases/tools/`
- Problem solved: validation, fingerprints and exact-source packets. The SEV3 contract requires Looprch to use the trusted identical copy.
- Complexity: Low (Python standard library).
- Needed: yes. Works without it: no.

**@clack/prompts** — https://github.com/bombshell-dev/clack (1.8.1, 2026-09-13, MIT, 4 small deps)
- Problem solved: multi-select with ↑/↓, Space and Enter, plus confirmations and spinners for `looprch add`.
- Better than in-house: raw-mode terminal handling is fiddly and easy to get wrong.
- Complexity: Low (bundled into `dist/`). Alternative of equal quality: `@inquirer/checkbox` (5.2.5).
- Works without it: only with `--agents … --yes`.

**QuotaLens** (`quotalens` 1.0.0, installed; JSON schema 1.0)
- Problem solved: reset times for each provider's limit windows, used by the wait/fallback rule [D-07].
- Better than in-house: provider-specific probing already exists there.
- Complexity: Low (one CLI call, cached for 60 s).
- Needed: yes (user decision). Works without it: yes, every provider is treated as unknown.

**vercel-labs `skills` CLI** — https://github.com/vercel-labs/skills (1.7.0, MIT)
- Problem solved: installing delegate-skills by its documented method. It is not used for Looprch's own skills, because those must be versioned with the CLI.
- Complexity: Low (invoked through npx only when needed). Note: telemetry is on by default; pass `DISABLE_TELEMETRY=1`.

**git CLI via `execFile`; `node:test`; `util.parseArgs`; TypeScript + esbuild (dev only)**
- Problem solved: everything Looprch needs, with no wrapper libraries.
- Complexity: Low.

## OPTIONAL

**rulesync docs** — https://github.com/dyoshikawa/rulesync
- Role: reference only, for checking per-agent file paths. Not a dependency.

## NOT NEEDED

**MegaMemory** — https://github.com/0xK3vin/MegaMemory (v1.6.2, 2026-05-03, quiet since)
- Problem it solves: semantic project memory, kept as an MCP knowledge graph.
- Why not:
  - Its memory is LLM-written summaries, which conflicts with SEV3's "exact sources only" rule.
  - It brings native libsql, a 23 MB embedding model and a binary database that git can't merge.
  - It needs per-agent MCP setup.
- Looprch's continuity already comes from handovers, state files and packets.

**Beads (gastownhall/beads, now uses Dolt), Backlog.md, Task Master AI**
- Problem they solve: agent task tracking.
- Why not: SEV3 forbids a second tracker (`todo.md` is the only one). Beads adds Go and Dolt; Task Master uses a Commons Clause license and a heavy dependency tree.

**ruler, rulesync (as a dependency)**
- Problem they solve: syncing instructions across agents.
- Why not: Looprch writes only about six kinds of file. rulesync pulls in effect, fastmcp, octokit and more.

**basic-memory (AGPL), mem0, Letta**
- Why not: memory servers and platforms; far heavier than local files.

**OpenSpec, spec-kit**
- Why not: they overlap with SEV3's role.

**SQLite, simple-git/isomorphic-git, commander/yargs, zod/ajv**
- Why not: JSON plus a journal suffices for one writer (5.x showed SQLite's cost); the git CLI, `parseArgs` and small hand validators are enough.

**Daemon, HTTP server, MCP server for Looprch**
- Why not: there is no problem that they solve.
