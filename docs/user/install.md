# Install

## Requirements

- Linux or macOS (Windows: use WSL)
- Node.js 22 or newer, with `npx`
- Python 3.10 or newer as `python3` (the SEV3 toolkit)
- git
- Optional: the agent CLIs you want to use, delegate-skills relays, QuotaLens

## npm (primary)

```sh
npx looprch@latest install
```

## curl

```sh
curl -fsSL <url>/install.sh | sh
```

`install.sh` only checks the prerequisites above and runs the same `npx -y looprch@<version> install`.
Set `LOOPRCH_VERSION=0.1.0` to pin a version.

## From a checkout (before publication)

```sh
npm ci && npm run build
node dist/looprch.mjs install --from .
```

## What install does

```text
~/.looprch/versions/<version>/   immutable copy: dist/, assets/, vendor/, schemas/, VERSION, MANIFEST.sha256
~/.looprch/current               symlink to the active version
~/.local/bin/looprch             shim: exec node ~/.looprch/current/dist/looprch.mjs
```

If `~/.local/bin` is not on your `PATH`, `looprch install` prints the exact line to add to your
shell profile. Projects only ever reference `~/.looprch/current`, never the npx cache or an nvm
path. `LOOPRCH_HOME` overrides `~/.looprch`.

Check the installation with `looprch self-test` (no network) and `looprch version`.

## Uninstall

`looprch uninstall` removes the shim and `~/.looprch/` after listing your registered projects.
Project `.looprch/` folders are never deleted.
