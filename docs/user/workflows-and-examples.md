# Workflows and examples

## A mixed-agent configuration

The Lead runs in Cursor; Planner and Reviewer are Cursor subagents; Kimi debates; OpenCode
implements with Codex as fallback; Codex tests.

```sh
looprch add . --agents cursor,codex,opencode,kimi --yes
looprch config set lead_host cursor
looprch config set-role planner      --mode direct   --agent cursor   --model <cursor-model>
looprch config set-role plan_debater --mode delegate --agent kimi     --model <kimi-model>
looprch config set-role implementer  --mode delegate --agent opencode --model <provider/model> --effort high --timeout 2h
looprch config add-fallback implementer --mode delegate --agent codex --model <codex-model>
looprch config set-role tester       --mode delegate --agent codex    --model <codex-model>
looprch config set-role reviewer     --mode direct   --agent cursor   --model <cursor-model>
looprch config set-role worker       --mode delegate --agent codex    --model <codex-model>
looprch config validate
```

## Resume after a restart

Close everything mid-phase, reboot, open the project in any enabled agent and run `/lr-resume`.
Looprch reads `state.json`: a Delegate run still in progress is awaited, a finished one is
recorded, a vanished one is retried in its session. If you now run the Lead in Codex, the Direct
Cursor roles run through `cursor-delegate` automatically (status shows `direct→delegate`).

## Ad hoc review of an old phase

```text
/lr-review P-004
```

The Reviewer reads `git diff looprch/P-004^1 looprch/P-004` and the phase evidence and writes
`.looprch/phases/P-004/reviews/adhoc-<timestamp>.md`. The phase stays closed.

## Ask a Worker

```text
/lr-worker Where is tenant isolation enforced in the HTTP layer?
```

The answer, with file paths, is saved under `.looprch/phases/<current>/workers/`. Use it to
decide; it is not evidence for a gate.

## Shell-only check before lunch

```sh
looprch status
looprch log -n 10
```

## Unattended phases

`/lr-auto` keeps going until the closure phase, waiting for usage limits and switching to
fallbacks by itself. It stops on any block or question.
