---
name: lr-review
description: Looprch - run an extra independent read-only Reviewer on a phase (current or already closed); it never changes the phase status. Use when the user runs /lr-review [P-NNN].
---
# /lr-review

Your host id: Codex `codex`, Cursor `cursor`, Antigravity `agy`, Kimi Code `kimi`, Hermes
`hermes`, OpenCode `opencode`, Grok Build `grok`.

1. Run `looprch review <P-NNN> --host <host> --json` (omit the phase id for the current phase).
   It returns one `run_role` action for the Reviewer.
2. If `"mode": "delegate"`: run `command`; if it reports `"status": "running"`, run
   `looprch dispatch --wait <run_id> --json` until it finishes.
   If `"mode": "direct"`: start your native subagent `subagent` with model `model` and the single
   instruction "Read and follow the brief at `<brief>` exactly", then pipe its complete final
   message into `record_command`.
3. Report the decision and the findings. The review file is written to
   `.looprch/phases/<P-NNN>/reviews/` (`output_path`). It is advisory: it never reopens or closes a
   phase. For a closed phase the Reviewer reads `git diff looprch/<P-NNN>^1 looprch/<P-NNN>`.
