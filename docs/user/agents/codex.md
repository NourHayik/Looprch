# Codex CLI

- Binary: `codex`
- Skills: `.agents/skills/lr-*` (Codex follows symlinked skill folders)
- Invoke: `$lr-init`, `$lr-phase`, ... (or pick from `/skills`)
- Direct: `.codex/agents/lr-<role>.toml` with the role's model (`sandbox_mode = "read-only"` for
  read-only roles). File format unverified by a live spike; if your Codex version rejects it, use
  Delegate for those roles.
- Delegate: `codex-delegate` relay. Session field `threadId`, resumed with `--session`.
  Read-only is enforced by the Codex sandbox (`--read-only`). Effort: `--effort`.
  Looprch passes `--clean-env`.
- QuotaLens provider: `codex`

## Notes

- `codex exec` needs a git repository; Looprch creates one before the first phase.
- Install the relay: `looprch install-relay codex`.
- `--clean-env` launches Codex with only runtime basics; it does not protect files or other
  same-user secrets.
