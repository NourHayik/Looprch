# Hermes

- Binary: `hermes`
- Skills: `.agents/skills/lr-*`, loaded only in a git repository that you trusted with
  `hermes skills trust`
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

## Make the Looprch commands appear

Hermes treats project skills as untrusted input, so it loads `.agents/skills/lr-*` only when all
of these hold:

1. **The project is a git repository.** Hermes finds the project root by walking up from the
   current directory to the nearest `.git`. In a folder without one it loads no project skills,
   and `hermes skills trust` answers "Not inside a git checkout".
2. **The project root is trusted.** `hermes skills trust` adds it to
   `skills.trusted_project_dirs` in `~/.hermes/config.yaml`.
3. **The Hermes session started after you trusted it.** Hermes reads the trust list once per
   session; quit and start a new session.
4. **The skill passed Hermes's scan.** Hermes scans every project skill and hides one it rates
   "dangerous". The Looprch skills pass, but a locally edited copy might not.

From the project root:

```sh
git init               # only if the project is not a git repository yet
hermes skills trust
hermes                 # new session; type /lr to list the Looprch commands
```

Run Hermes from inside the project. In the desktop app or the gateway, set the session's working
directory to the project.

Checked with Hermes 0.21.5.

## Notes

- Hermes loads only the first of `.hermes.md`, `AGENTS.md`. If you keep a `.hermes.md`, copy the
  Looprch block from `AGENTS.md` into it; `looprch doctor` warns otherwise.
