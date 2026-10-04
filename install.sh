#!/bin/sh
# Looprch installer: checks prerequisites, then runs the same npx command as the npm channel.
#   curl -fsSL <url>/install.sh | sh
#   LOOPRCH_VERSION=0.1.1 sh install.sh
# LOOPRCH_NPX_SPEC overrides the npx package spec (testing a local tarball).
# Uses the npm registry when looprch is published there, otherwise github:NourHayik/Looprch.
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

if [ -n "${LOOPRCH_NPX_SPEC:-}" ]; then
  SPEC="$LOOPRCH_NPX_SPEC"
elif npm view looprch version >/dev/null 2>&1; then
  SPEC="looprch@${LOOPRCH_VERSION:-latest}"
else
  # Not on the npm registry yet: install from GitHub (npm builds it through the prepare script).
  SPEC="github:NourHayik/Looprch${LOOPRCH_VERSION:+#v$LOOPRCH_VERSION}"
fi
printf 'Installing %s ...\n' "$SPEC"
exec npx -y "$SPEC" install
