# OpenCode

- Binary: `opencode`
- Skills: `.agents/skills/lr-*` (OpenCode follows symlinks) plus command shims
  `.opencode/commands/lr-*.md` that load the skill
- Invoke: `/lr-init`, `/lr-phase`, ... through the command shims
- Direct: `.opencode/agents/lr-<role>.md` (`mode: subagent`, the role's model; edits denied for
  read-only roles).
- Delegate: `opencode-delegate` relay. Session field `sessionId`, `--session`. Read-only through
  the plan agent (`--read-only`). Effort is sent as `--variant`.
- QuotaLens provider: `opencode`

## Notes

- Models must be written `provider/model` (see `opencode models` or `looprch models opencode`).
- Install the relay: `looprch install-relay opencode`.
