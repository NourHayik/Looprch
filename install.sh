#!/bin/sh
# Looprch installer: checks prerequisites, then runs the same npx command as the npm channel.
#   curl -fsSL <url>/install.sh | sh
#   LOOPRCH_VERSION=0.1.0 sh install.sh
# LOOPRCH_NPX_SPEC overrides the npx package spec (testing a local tarball).
set -eu

fail() {
  printf 'looprch install: %s\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux | Darwin) ;;
  *) fail "Linux or macOS required (on Windows, use WSL)." ;;
esac

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required (node not found)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "Node.js 22 or newer is required (found $(node --version 2>/dev/null))."

command -v npx >/dev/null 2>&1 || fail "npx is required (it ships with npm)."

command -v python3 >/dev/null 2>&1 || fail "Python 3.10 or newer is required (python3 not found)."
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null \
  || fail "Python 3.10 or newer is required (found $(python3 --version 2>&1))."

command -v git >/dev/null 2>&1 || fail "git is required."

SPEC="${LOOPRCH_NPX_SPEC:-looprch@${LOOPRCH_VERSION:-latest}}"
printf 'Installing %s ...\n' "$SPEC"
exec npx -y "$SPEC" install
