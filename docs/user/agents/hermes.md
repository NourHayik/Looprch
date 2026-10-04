# Hermes

- Binary: `hermes`
- Skills: `.agents/skills/lr-*` after `hermes skills trust` in the project
- Invoke: `/lr-init`
- Direct: not supported in this version (Hermes has no file-based subagents).
- Delegate: none. There is no `hermes-delegate` relay, so no role can be assigned to Hermes.
- QuotaLens provider: none

## Use Hermes as the Lead only

Run `/lr-phase` and `/lr-auto` in Hermes with every role set to Delegate on other agents:

```sh
looprch config set lead_host hermes
looprch config set-role planner --mode delegate --agent codex --model <model>
```

## Notes

- Run `hermes skills trust` once, or Hermes ignores project skills.
- Hermes loads only the first of `.hermes.md`, `AGENTS.md`. If you keep a `.hermes.md`, copy the
  Looprch block from `AGENTS.md` into it; `looprch doctor` warns otherwise.
