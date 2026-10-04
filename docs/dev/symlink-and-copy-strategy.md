# Symlink and copy strategy

## What is linked

Each of the ten skills becomes `<project>/<skillDir>/lr-<cmd>` pointing at
`$LOOPRCH_HOME/current/assets/skills/lr-<cmd>`. Skill discovery expects
`skills/<name>/SKILL.md` one level deep, so a single directory link is not used. Switching
`current` (update, rollback) keeps links valid.

## When copies are used

`decideLinkModes(agents, forceCopy)` in `src/install/links.ts` decides per skill directory:

- `copy` if `--copy` was given (sticky: recorded in `projects.json`), on WSL, or if any enabled
  agent reading that directory has `followsSymlinks !== true`;
- otherwise `symlink`.

After the spikes, Codex and OpenCode have `followsSymlinks: true`; the others are `"unverified"`
until spike S-1 runs (see [spike-results.md](spike-results.md)). `LOOPRCH_FORCE_SYMLINK=1`
forces links for that spike.

Copies get a `.looprch-version` stamp. `looprch update` and `looprch add .` refresh copies whose
stamp differs from the core version.

## Ownership and repair

- A link is Looprch's when its target starts with `$LOOPRCH_HOME/`. A copy is Looprch's when it
  contains `.looprch-version`. Anything else is foreign and is reported, never touched.
- `looprch add .` and `looprch update` recreate missing or broken links, convert between modes
  and delete Looprch `lr-*` entries for skills that no longer exist.
- `looprch doctor` reports missing, broken, foreign and outdated entries without changing them.

Links contain absolute paths, so they are gitignored; a fresh clone runs `looprch add .`.
