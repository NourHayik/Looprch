# Update and rollback

```sh
looprch update                 # latest version from npm
looprch update --to 0.2.0      # a specific version
looprch update --from ./pkg    # an extracted package directory
looprch rollback               # back to the previous version
```

`update`:

1. Finds the package: the npm registry when `looprch` is published there, otherwise the GitHub
   repository (`github:NourHayik/Looprch`, or the tag `v<version>` with `--to`). `--from` uses a
   local directory.
2. Warns if a registered project has a phase in progress and asks you to confirm (`--yes` skips).
3. Installs into `~/.looprch/versions/<new>/` beside the current one and verifies its manifest.
4. Runs `looprch self-test` from the new version. A failure leaves `current` untouched.
5. Switches `current` atomically, refreshes copy-mode projects and removes dangling skill links.
6. Keeps the two most recent versions.

## Mid-phase updates

Each phase records the protocol version it started with. If an update changes the protocol, the
next `looprch next` answers `paused` with the reason `protocol_changed`; run `looprch resume`
(or `/lr-resume`) to continue the phase with the new protocol.

Config and state files carry a `schema_version`. Newer Looprch versions migrate them
automatically and keep a backup in `.looprch/backups/`. If a project was written by a newer
Looprch than the one you run, Looprch refuses and asks you to update.
