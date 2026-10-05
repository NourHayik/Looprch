# Delegate integration and sessions

## Relay location (`src/delegate/locate.ts`)

Search order for `<agent>-delegate/scripts/relay.mjs`: `<project>/.agents/skills`,
`~/.agents/skills`, `~/.codex/skills`, `~/.claude/skills`, `~/.cursor/skills`. The first wins;
copies elsewhere with a different sha256 produce a doctor warning naming the chosen one. Path,
version (from the skill's SKILL.md) and hash are cached in `~/.looprch/cache/doctor.json`, never
in project config. Relays are never bundled; `looprch install-relay <agent>` runs
`DISABLE_TELEMETRY=1 npx -y skills add amElnagdy/delegate-skills -g -y --copy --agent codex --skill <x>-delegate`
(verified by spike S-9).

## Argv (`buildRelayArgv`)

```text
node <relay> --brief <abs brief> --cd <project> --out-dir .looprch/runs/<id>/relay --timeout <t>
     --model <m> [--effort e | --variant e] [--print-timeout <t>]
     [--read-only | <writeFlags>] [--session id | --conversation id] [--clean-env]
```

Flags are emitted only when the adapter supports them; unsupported effort and read-only produce
warning events. Lanes (`--lane`) and `--resume-last` are never used (D-15).

- `printTimeoutFlag` (agy): the run timeout is also passed as the CLI's own print-mode timeout,
  so agy does not stop at its 30-minute default before the relay watchdog.
- `writeFlags` (agy: `--dangerously-skip-permissions`): passed only to write runs, never with
  `--read-only` (the relay rejects the pair). Headless `agy --print` cannot prompt and would
  auto-deny tool permissions. Every such run emits a `warning` event.

## Detached dispatch

1. `looprch dispatch <id>`: under the lock, set the run `running` with its argv, spawn
   `looprch _run-relay <id>` detached (`setsid`, stdio ignored), store its pid.
2. Without the lock, wait up to `--max-wait` for `exit.json` or the wrapper's exit.
3. The wrapper runs the relay (stdout/stderr to `relay.stdout`/`relay.stderr`), writes
   `exit.json {code, signal}`, then finalizes under the lock (retrying while busy).
4. Whoever sees completion first records the result; finalization is idempotent.

Result handling (`delegate-relay.result.v1`): `completed` → parse the `looprch-result` block from
`finalMessage`; `failed`/`timeout`/`aborted` → retry, fallback or block; `*_unavailable` →
fallback or `cli_missing`; rate-limit wording → mark the provider; no `result.json` with exit 2
→ `usage_error`; no result otherwise → interrupted → retry. The relay's `error` field (for example
agy's headless permission denial) comes first in the failure detail, followed by `stderrTail`.

## Sessions (`src/delegate/sessions.ts`)

Key `P-NNN/<role>/<agent>` with `{session_id, mode, resumable, created_at, last_used, runs[]}`.
A role's later runs in the same phase resume the stored session (`--session` / `--conversation`;
Direct: passed to the Lead in `session.id`). A non-resumable adapter, a missing id, or a resume
that returned a different id marks it non-resumable; the next run gets a fresh session with the
full packet and earlier final messages. Each phase starts new sessions.

## Read-only checks

Read-only roles get `--read-only` where the relay supports it. Looprch always hashes the working
tree before and after (`snapshotTree`); any change, or `readOnlyViolation` from the relay, blocks
with `readonly_violation`. Looprch never reverts files.

## Environment hygiene

`--clean-env` is passed only to `codex-delegate`, the one target relay that supports it. Other
relays inherit the environment; this is a documented limitation.
