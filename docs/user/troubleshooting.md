# Troubleshooting

Start with `looprch doctor` and `looprch status`. Every blocked state has a code, a reason and a
hint; after fixing the cause run `looprch resume` (or `/lr-resume`).

| Code | Meaning | Fix |
|---|---|---|
| `spec_changed` | The SEV3 package no longer matches the recorded fingerprint, or fails verification | Never edit generated files. Reseal an authorized amendment with SEV3, then `looprch init discover --accept-fingerprint`. Closed evidence is never rewritten. |
| `toolkit_untrusted` | `phases/tools/` differs from Looprch's SEV3 toolkit 1.2.0 | Restore the original toolkit files |
| `not_initialized` | The package was never discovered | `/lr-init` or `looprch init discover` |
| `repair_limit` | Repairs reached `limits.repair_rounds` | `looprch resume --note "<instruction>"` (one more round) or raise the limit |
| `merge_conflict` | The phase branch conflicts with the base branch | Resolve as in [handover-and-git.md](handover-and-git.md) |
| `head_mismatch` | You switched branches or committed during a phase | `git switch looprch/P-NNN`, undo foreign commits yourself |
| `dirty_tree` | Uncommitted files before a phase | Commit or remove them |
| `no_git_identity` | git has no user.name/user.email | `git config --global user.name ...` |
| `hook_failed` | A git hook rejected Looprch's commit | Fix the hook failure |
| `relay_missing` | A relay is not installed | `looprch install-relay <agent>` |
| `cli_missing` | An agent CLI is not on PATH or unavailable | Install it or reassign the role |
| `delegate_unsupported` | A role would need a Hermes relay | Run the Lead in that agent or reassign |
| `config_invalid` | Roles or limits are invalid | `looprch config validate` |
| `result_invalid` | A role twice returned no valid `looprch-result` block | Read `.looprch/runs/<run>/final.md`, `looprch resume` |
| `handover_mismatch` | Handover file lists still differ from git | `looprch resume` to ask again |
| `readonly_violation` | A read-only role changed files | Undo the changes yourself (Looprch never reverts) |
| `run_failed` | A role failed `limits.run_attempts` times and no fallback is left | Inspect the run folder, `looprch resume`. For "Antigravity auto-denied the … permission", see [agents/antigravity.md](agents/antigravity.md#permissions-in-phases) |
| `usage_error` | A relay rejected Looprch's arguments | A Looprch bug: report `.looprch/runs/<run>/relay.stderr` |
| `expansion_limit` | A role asked for extra sources too often | `looprch resume` allows one more round |
| `phases_remaining` | `/lr-finish` before the implementation phases are closed | `/lr-auto` first |
| `host_not_enabled` | `--host` names an agent not enabled here | `looprch add . --agents <agent>` |

## Other problems

- **"Another Looprch process holds the project lock"** (exit code 3): another command is running.
  A lock from a dead process on this machine is reclaimed automatically.
- **Skills do not appear in an agent**: run `looprch add .`; for Grok trust the folder. Agents that
  may not follow symlinks get copies. Hermes also needs a git repository, `hermes skills trust` and
  a new session; see [Hermes](agents/hermes.md#make-the-looprch-commands-appear).
- **`looprch` not found**: add `~/.local/bin` to `PATH` (the install prints the exact line).
- **Mode-600 files from another user**: `looprch init discover` names them; fix permissions.
- **Looprch 5.x project**: 0.x refuses `.looprch/` folders from 5.x; move the old folder away.
