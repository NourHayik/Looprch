---
name: lr-worker
description: Looprch - ask the read-only Worker a bounded question (repository exploration, references, dependency analysis); its answer is advisory evidence only. Use when the user runs /lr-worker <question>.
---
# /lr-worker

Your host id: Codex `codex`, Cursor `cursor`, Antigravity `agy`, Kimi Code `kimi`, Hermes
`hermes`, OpenCode `opencode`, Grok Build `grok`.

1. Run `looprch worker "<question>" --host <host> --json`. It returns one `run_role` action.
2. If `"mode": "delegate"`: run `command`; if it reports `"status": "running"`, run
   `looprch dispatch --wait <run_id> --json` until it finishes.
   If `"mode": "direct"`: start your native subagent `subagent` with model `model` and the single
   instruction "Read and follow the brief at `<brief>` exactly", then pipe its complete final
   message into `record_command`.
3. Report the answer with its evidence paths (`output_path` holds the saved file).

The Worker is read-only and advisory: its answer never replaces a requirement, never approves a
design and never satisfies a gate. Several Workers may run in parallel up to
`roles.worker.max_parallel`.
