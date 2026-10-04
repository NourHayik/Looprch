# Debugging

## Where to look

| Question | Look at |
|---|---|
| What is Looprch waiting for? | `looprch status`, `looprch next --host <h> --json` (safe to repeat) |
| What happened? | `looprch log -n 50`, `.looprch/events.jsonl` |
| What did a role receive? | `.looprch/runs/<run_id>/brief.md` and the packet it names |
| What did a role answer? | `.looprch/runs/<run_id>/final.md`, `run.json` |
| What did the relay do? | `.looprch/runs/<run_id>/relay/` (`result.json`, events, stderr), `relay.stdout`, `relay.stderr`, `exit.json`, `wrapper.error` |
| Why did a gate fail? | `.looprch/phases/P-NNN/gates.json`, `.looprch/runs/P-NNN-gates-<n>/<gate>.out/.err` |
| Which relay is used? | `looprch doctor` (`relay:<agent>`), `~/.looprch/cache/doctor.json` |

`run.json` holds the effective mode and reason, model, session in/out, attempt, status, relay
path and hash, argv, start/finish times, the working-tree hashes before and after and the touched
files.

## Common situations

- **`await_run` forever**: check `ps` for the wrapper pid in `run.json`. If it is gone,
  `looprch next` records the run as interrupted and retries.
- **A role keeps failing**: read `relay.stderr` and `relay/result.json` (`stderrTail`).
- **Lock busy**: `.looprch/lock` names the pid and command.

## Manual smoke checklist (real agents)

Use a throwaway copy of `test/fixtures/notes-spec` in a new git repository.

1. `looprch add . --agents <agent>` and confirm the skills are visible in the agent.
2. `/lr-init` with every role on that agent (Delegate) and a cheap model.
3. `/lr-phase` and confirm: Planner, Debater, Implementer, Tester and Reviewer run; gates pass;
   `looprch/P-001` is tagged.
4. Repeat with one Direct role on the host agent.
5. Run `/lr-status` during a long Implementer run, then interrupt the agent and run
   `/lr-resume` in a new chat.
6. Record the agent version and outcome in `spike-results.md`.
