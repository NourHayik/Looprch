# Install

## Requirements

- Linux or macOS (Windows: use WSL)
- Node.js 22 or newer, with `npx`
- Python 3.10 or newer as `python3` (the SEV3 toolkit)
- git
- Optional: the agent CLIs you want to use, delegate-skills relays, QuotaLens

## npm

```sh
npx looprch@latest install
npx looprch@0.4.1 install      # a specific version
```

## From GitHub

```sh
npx github:NourHayik/Looprch install            # latest main
npx github:NourHayik/Looprch#v0.4.1 install     # a tagged version
```

npm clones the repository, installs the build tools, builds `dist/` through the `prepare`
script and runs `looprch install` from the result. The first run takes about a minute.

## curl

```sh
curl -fsSL https://raw.githubusercontent.com/NourHayik/Looprch/main/install.sh | sh
```

`install.sh` only checks the prerequisites above and runs `npx -y <spec> install`, where the spec
is `looprch@<version>` when the package is on npm and `github:NourHayik/Looprch[#v<version>]`
otherwise. Set `LOOPRCH_VERSION=0.4.1` to pin a version.

## From a checkout

```sh
npm ci        # also builds dist/ (prepare script)
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
