# Update, versioning and migrations

## Versions

| Version | Where | Meaning |
|---|---|---|
| Package semver | `package.json`, `VERSION` | release identity |
| Protocol | `PROTOCOL` in `src/core/constants.ts`, recorded in `state.json` at phase start | behavior of roles, briefs and lifecycle; a change pauses a running phase until resumed |
| Config schema | `config.json.schema_version` | migrated by pure functions with a backup |
| State schema | `state.json.schema_version` | same |
| SEV3 toolkit | `vendor/sev3-toolkit/<v>/` | changed only by a Looprch release; unknown package toolkits are rejected |

## Install, update, rollback

`src/install/central.ts`: `installVersion(src)` copies `dist assets vendor schemas VERSION
MANIFEST.sha256` into `versions/<v>.tmp-<pid>`, verifies the manifest and renames it into place.
`switchCurrent(v)` creates a temporary symlink and renames it over `current`, recording
`{current, previous}` in `install.json`. `prune(2)` keeps the two newest plus current and
previous. `update` runs the new version's `self-test` in a child process before switching; any
failure leaves `current` untouched. `rollback` switches to `previous`.

## Migrations

`migrate(doc, kind, target, migrations, backupDir, sourcePath)` in `src/core/migrations.ts`:

- `schema_version` equal to the target → unchanged;
- newer than the core supports → `schema_too_new` ("update Looprch");
- older → backup to `.looprch/backups/<file>.<ts>.json`, apply each `{from, up}` step, write.

To change the config schema: bump `CONFIG_SCHEMA`, add a `Migration` with `from: <old>` to
`CONFIG_MIGRATIONS`, update `defaultConfig`, the validator, `schemas/config.schema.json` and the
tests. Same for state.

## Protocol changes

Bump `PROTOCOL` when the meaning of briefs, role results or transitions changes. Projects with a
phase in progress then pause with `protocol_changed` until the user resumes.
