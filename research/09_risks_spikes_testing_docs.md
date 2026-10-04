# 09 — Risks, verification spikes, testing, documentation, scope

## 1. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agents may not follow symlinked skill folders (confirmed only Codex, OpenCode) | Spike per agent; per-agent copy mode + version stamp + refresh on update |
| Slash-command syntax differs (`/lr-init`, `$lr-init`, `/skill:lr-init`, OpenCode command shims) | Adapter `invoke()`; printed after `add`; docs page per agent |
| Hermes / Grok ignore project skills until trusted; Hermes reads only first context file | `postInstallNotes`; doctor check; docs |
| Hermes has no delegate relay | Hermes can be Lead host only; config validation prevents Delegate to Hermes |
| Relays differ in session field / resume / read-only / clean-env | Adapter capability fields; fresh-session fallback; git-status read-only check |
| Duplicate delegate-skills installs with different files | Deterministic search order, hash cache, doctor warning |
| Cursor IDE subagent model slugs may differ from `cursor-agent` slugs (affects D-05 auto-delegate) | Spike; adapter model mapping or validation with clear error |
| Huge packets (Corebit P-089 920 KB) | Context-size guard + fallback; never truncate |
| Core update mid-phase changes prompts | Protocol version recorded at phase start; mismatch pauses; update warns |
| Implementer switch by quota fallback loses context | Checkpoint commit, full packet + diff + prior outputs to new agent, assignment history |
| Tester/Implementer write boundaries are policy only | Touched files recorded per run; Reviewer checks; handover lists contributors |
| Gate commands are arbitrary binaries from the spec | Shown once at `/lr-init` and acknowledged with manifest hash |
| Same-user processes can read secrets; `--clean-env` only on some relays | Documented limitation; use `--clean-env` where supported |
| Mode-600 SEV3 files under another uid/container | Readability check with explicit error |
| Existing 5.x `.looprch/` (Corebit) | Detect and refuse; never overwrite |
| Two Leads on one project | Lock file with pid/hostname |
| No git identity configured | Stop with instructions, never invent |
| npm name `looprch` could be taken before publication | Reserve early; existing GitHub repo `NourHayik/Looprch` (old skills) — decide publication repo later |

## 2. Verification spikes (do first in implementation; record results in docs/dev)

1. Symlinked `.agents/skills/<name>` discovered by: Cursor (IDE + CLI), agy, Kimi Code, Hermes (after trust), Grok Build.
2. Slash-command invocation of a project skill per agent (and OpenCode command shim behavior).
3. Direct subagent with a configured model per host: Cursor `.cursor/agents`, Codex `.codex/agents/*.toml`, OpenCode `.opencode/agents`, agy, Kimi; how the host returns a session id.
4. Relay exact-session resume per target (`--session` / `--conversation`) with a tiny brief.
5. Read-only behavior per relay (enforced vs best-effort vs none).
6. `discover.mjs` output shape and runtime; model lists per CLI.
7. QuotaLens provider ids for each agent and rate-limit failure text per relay.
8. `@clack/prompts` multiselect UX with an "Enabled" preamble in common terminals.
9. Exact `npx skills add … --skill <x>-delegate` flags for global non-interactive install.

## 3. Testing strategy

- Unit (`node:test`): config validation/migrations, state transitions, lock, atomic writes, todo
  updater, unittest/JUnit parsers (including a file with declared failures), quota policy,
  mode resolution, adapter file generation (snapshot), AGENTS.md block idempotency.
- Integration: install/update/rollback into a temp `LOOPRCH_HOME`; `add` twice (idempotent),
  add more agents, remove; copy mode; broken-link repair; 5.x layout refusal.
- Fake relays: Node scripts that write `delegate-relay.result.v1` results (completed, failed,
  timeout, rate-limited, non-resumable, read-only violation).
- E2E: SEV3 `notes-spec` example (3 phases) in a temp git repo with fake relays and real
  Python unittest gates → all phases closed, todo ticked, tags present, handovers checked,
  repair loop and cap exercised, interruption and resume, spec change detection, quota wait and
  fallback.
- Toolkit: vendored files' hashes equal `../sev3/assets/package/phases/tools/`.
- No live paid model calls in CI; a documented manual smoke checklist for real agents.

## 4. Documentation plan (English only [D-20])

`docs/user/`: index (what Looprch is), concepts (SEV3, delegate-skills, roles, Direct/Delegate),
install, update-and-rollback, quickstart, attach-a-project, lr-init, agents (one page per agent:
invocation syntax, trust steps, limits), roles-and-modes, running-phases, status-and-logs,
handover-and-git (required by SEV3's EXECUTION_GUIDE), quota-and-fallbacks, troubleshooting,
command-reference, workflows-and-examples, faq.

`docs/dev/`: architecture, repository-structure, cli-architecture, shared-vs-project-state,
symlink-and-copy-strategy, agent-adapters (adding a new agent), schemas (config/state/events/
role results), lifecycle-state-machine, bootstrap-and-preflight, sev3-integration,
delegate-integration-and-sessions, quota-integration, git-integration, update-versioning-
migrations, testing, debugging, spike-results, contributing, release-process.

## 5. Out of scope for v1 (later)

Parallel Implementers; write-capable Worker; native Windows; fully headless runner
(`looprch auto --headless`); per-project core version pinning; SEV3 packages in subfolders;
migration of 5.x projects; publication repository choice.

## 6. Suggested build order (the plan may refine it)

1. Repo scaffold, build, test harness, conventions, AGENTS.md for contributors.
2. Verification spikes (§2) — results may adjust adapters.
3. Core utilities: atomic fs, lock, journal, config + migrations, state.
4. Central install / update / rollback / shim / registry.
5. Agent adapters, `add` / `remove` / `list`, link and copy modes, AGENTS.md block.
6. SEV3 integration: vendored toolkit, discovery, trust, verify, fingerprint, packets, todo.
7. Doctor, `/lr-init` bootstrap, delegate-skills discovery/install, QuotaLens adapter.
8. Lifecycle engine: `next` / `record`, briefs, role templates, result parsing, gates runner.
9. Delegate dispatch, sessions, mode resolution, quota policy and fallbacks.
10. Git integration.
11. Skills `/lr-*` content; status / log / pause / resume / review / finish / worker.
12. E2E suite on notes-spec.
13. User and developer documentation.
14. Release packaging (`npm pack`, `install.sh`, CHANGELOG), still unpublished.
