# CLI architecture

- `src/cli/main.ts` maps command names to `run(argv): Promise<number>` handlers. Hidden command:
  `_run-relay` (the detached dispatch wrapper).
- Arguments use `node:util` `parseArgs` through `src/cli/args.ts` (`--json`, `--help` and
  `--root` are common). Unknown flags are usage errors (exit 2).
- Output goes through `src/cli/output.ts`: human text, or JSON with `--json`. Errors are
  `LrError(code, message, hint, exitCode, details)`; with `--json` they print
  `{"ok": false, "error": {"code", "message", "hint", "details"}}`.
- Exit codes: 0 ok, 1 error, 2 usage, 3 project lock busy.
- The project root is `--root`, else the git top-level of the current directory, else cwd.

## Stability

JSON output of agent-facing commands (`next`, `dispatch`, `record`, `gates run`, `answer`,
`status`, `doctor`, `init discover`, `config validate`, `models`) is an interface used by the
skills. Add fields; never rename or remove them without a protocol bump.

## Progress lines

`next`, `record` and `dispatch` add `progress: string[]` to their JSON (and print the lines above
their human output). Under the project lock they read the journal events after the cursor
`.looprch/runs/progress.json` (`{reported_seq}`, gitignored so commits stay clean), render them
with `renderProgress` in `src/core/journal.ts` and advance the cursor. Without a cursor, reporting
starts at the journal's end, so upgraded projects do not replay old history. Events written by the
background dispatch wrapper are picked up by the Lead's next command. Side runs (`/lr-worker`,
`/lr-review`) return no progress and leave the cursor alone.

`renderProgress` has an exhaustive `switch` over event types: a new event type must choose a line
or `null` (low-level events such as `todo.ticked`, `gate.result` and `quota.fallback`, which is
reported through `assignment.changed`). Follow-up actions after a failure (`retry`, `fallback`,
`blocked`) are read from the events that follow it in the same batch. The skills' loop block tells
the Lead to post every line unchanged, then one `Now: … Next: …` line.

## Locking

Every command that mutates `.looprch/` runs inside `withLock(root, host, command, fn)`. The lock
file holds `{pid, hostname, host_agent, command, started, heartbeat}`. A live holder on the same
machine is waited for (up to 20 s, locks are held for seconds); a dead one is reclaimed; a holder
on another machine is never reclaimed.

## Long runs

`dispatch` marks the run `running`, spawns `looprch _run-relay <run_id>` detached, and waits at
most `--max-wait` (default `limits.dispatch_max_wait`, 10 minutes). The wrapper runs the relay,
writes `exit.json` and records the result under the lock. `next` answers `await_run` while the
wrapper is alive.
