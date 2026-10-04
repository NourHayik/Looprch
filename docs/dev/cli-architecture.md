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
