# Bootstrap and preflight

## Bootstrap (`/lr-init` → `looprch doctor`)

`runDoctor(root, quick)` in `src/cli/doctor.ts` returns `{ok, generated_at, checks[]}`; each
check is `{id, status: ok|warn|fail|skip, summary, fix?}`.

| Check ids | What |
|---|---|
| `node`, `python`, `git` | Node ≥ 22, Python ≥ 3.10, git present |
| `core_integrity`, `shim_path` | `MANIFEST.sha256` of `current`; shim present and on PATH |
| `layout_5x`, `project_attached`, `skill_links`, `agents_md_block`, `gitignore_block` | project attachment |
| `agent:<id>:binary`, `agent:<id>:auth`, `agent:<id>:support`, `agent:<id>:trust` | agent CLIs, logins (from cached discovery), unverified capabilities, trust steps |
| `relay:<agent>`, `relay_duplicates` | relay for every agent a role may reach; differing duplicate copies |
| `quotalens` | optional; unknown is allowed |
| `sev3_package`, `sev3_toolkit`, `sev3_readable`, `sev3_verify`, `gates_ack` | SEV3 discovery and trust |
| `git_repo`, `git_identity`, `git_clean` | git readiness |
| `roles_valid`, `context_budget:<role>`, `lock` | configuration |

`--quick` skips discovery, QuotaLens and stays under 2 seconds.

## Preflight before every phase

`preflightChecks` in `src/core/preflight.ts`, then git checks in `runPreflight`:

1. Config valid with all primary roles.
2. Package discovered (`state.spec.package_fingerprint` set).
3. Toolkit files equal the vendored copy.
4. `verify_package.py` passes and the package fingerprint equals the recorded one
   (S-10: 0.87 s on Corebit, 89 phases).
5. Gate commands acknowledged for the current manifest hash, else `ask_user ack_gates`.
6. Every primary role resolves to a runnable mode (relay and CLI present).
7. git: repository (created if missing), identity, baseline on the first phase, clean tree
   (ignoring Looprch's own `config.json`, `state.json`, `events.jsonl`), on the base branch.

Timings are journaled in `preflight.passed`. Expensive discovery (`discover.mjs`, 17 s) is never
run at preflight.
