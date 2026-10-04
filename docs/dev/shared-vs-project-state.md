# Shared core vs project state

## Central (`$LOOPRCH_HOME`, default `~/.looprch`)

```text
versions/<v>/          immutable installed copies (verified by MANIFEST.sha256)
current -> versions/<v>
install.json           {current, previous} for rollback
projects.json          [{path, agents, link_mode, added_at, last_seen_version}]
cache/doctor.json      relay locations and hashes, delegate-setup discovery (24 h)
cache/quota.json       last QuotaLens answer (60 s)
```

Nothing project-specific is written here except the registry entry and caches. The core never
writes inside `versions/` after install; the SEV3 toolkit runs with `python3 -B` so no bytecode
appears there.

## Project (`<project>/.looprch/`)

| Path | Git | Written by |
|---|---|---|
| `config.json` | committed | `looprch add`, `looprch config`, `looprch init` |
| `state.json` | committed | every mutating command |
| `events.jsonl` | committed | every mutating command (append-only) |
| `phases/P-NNN/` | committed | plan, debate, test-report, review, handover, gates.json, workers/, reviews/ |
| `user-rules.md` | committed | you (optional; listed in every brief) |
| `FINAL_REPORT.md` | committed | `/lr-finish` |
| `runs/ packets/ test-evidence/ reports/ backups/ lock` | ignored | runtime (`runs/progress.json` is the Lead's progress cursor) |

Writes are atomic (temp file in the same directory, fsync, rename, fsync of the directory).

## Separation rules

- Only static core content is linked into projects (skill folders). Nothing project-specific is
  written through a link, so a project cannot modify the core or another project.
- Files that contain project data (model names) are generated per project, never linked.
- Machine-specific facts (relay paths, link mode, discovery) live in `~/.looprch`, never in
  `config.json`.
