# Cursor

- Binaries: `cursor-agent` (or `agent`); the IDE for interactive use
- Skills: `.agents/skills/lr-*` (copied, not symlinked, until symlink support is verified)
- Invoke: `/lr-init`, `/lr-phase`, ...
- Direct: `.cursor/agents/lr-<role>.md` with frontmatter `name`, `model` and `readonly: true` for
  read-only roles. The Lead spawns it with its Task/subagent tool and pipes the final message into
  `looprch record <run_id> --stdin`, passing `--session <id>` when the subagent returns one.
- Delegate: `cursor-delegate` relay. Session field `sessionId`, `--session`. Read-only through
  plan mode (`--read-only`). No effort flag (effort is dropped with a warning).
- QuotaLens provider: `cursor`

## Notes

- Model names in the IDE subagent picker can differ from `cursor-agent models`. A Direct Cursor
  role that runs through `cursor-delegate` (because the Lead is elsewhere) uses the configured
  model string as is; use a slug that `cursor-agent models` lists.
- The relay's own default timeout is 30 minutes; Looprch always passes the role timeout.
