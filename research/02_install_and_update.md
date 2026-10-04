# 02 — Installation, update, versioning

## 1. Channels

- **Primary:** `npx looprch@latest install`
- **curl:** `curl -fsSL <url>/install.sh | sh`. The script only checks prerequisites (Node 22+,
  Python 3.10+, git) and runs `npx -y looprch@<version> install`. Same code path, no duplication.
- **Before publication / development:** `node dist/looprch.mjs install --from .` from a checkout.

Rationale: Node is required anyway (delegate-skills relays are Node). npm gives version lookup and
integrity for free. A bundled single-file CLI means there is no `node_modules` to install.

## 2. Central layout

```text
~/.looprch/
  versions/0.1.0/        immutable copy: dist/, assets/, vendor/, schemas/, VERSION, MANIFEST.sha256
  versions/0.2.0/
  current -> versions/0.2.0     switched atomically (create temp symlink, rename over)
  projects.json          registry: [{path, agents, link_mode, added_at, last_seen_version}]
  cache/doctor.json      cached expensive checks (discover.mjs output, relay paths/hashes)
~/.local/bin/looprch     shim: exec node "$HOME/.looprch/current/dist/looprch.mjs" "$@"
```

- `install` copies the package's own files (from the npx cache or `--from`) into
  `versions/<v>/`, verifies `MANIFEST.sha256`, switches `current`, writes the shim, and warns if
  `~/.local/bin` is not on PATH (prints the exact line to add).
- Override root with `LOOPRCH_HOME` (used by tests).
- Projects only ever reference `~/.looprch/current/...`.

## 3. Update and rollback

`looprch update [--to <version>] [--from <dir>]`:

1. Read latest version (`npm view looprch version`) or use `--to` / `--from`.
2. If any registered project has a phase in progress, warn and ask for confirmation.
3. Install into `versions/<new>/` beside the current one; verify hashes; run `looprch self-test`
   from the new version (no network, temp dirs).
4. Switch `current` atomically. Refresh copy-mode projects listed in `projects.json`.
5. Keep the previous version; prune to the two most recent.

`looprch rollback` switches `current` back to the previous version. A failed update never touches
`current`.

## 4. Versions and compatibility

| Version | Where | Meaning |
|---|---|---|
| Package semver | `VERSION`, `package.json` | Release identity |
| Protocol major | constant in core, recorded in `state.json` at phase start | Behavior of roles/briefs/lifecycle. A change mid-phase pauses that phase until the user resumes. |
| Config schema | `config.json.schema_version` (integer) | Pure migration functions `vN → vN+1`, run automatically with a backup in `.looprch/backups/`. If the project schema is newer than the core supports, Looprch refuses to run and asks to update. |
| State schema | `state.json.schema_version` | Same migration rule |
| SEV3 toolkit | `vendor/sev3-toolkit/<v>/` | Upgraded only by a Looprch release; packages with an unknown `toolkit_version` are rejected with a clear message |

## 5. Symlink validity

- Links target `~/.looprch/current/assets/skills/<skill>`; switching `current` keeps them valid.
- `looprch doctor` and `looprch add .` detect broken or foreign links and repair only links that
  Looprch created (identified by target prefix).
- If a version removes a skill, update refreshes registered projects and removes dangling links.

## 6. Uninstall

`looprch uninstall` removes shim and `~/.looprch/` after listing registered projects; project
`.looprch/` directories are never deleted automatically.
