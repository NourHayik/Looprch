# /lr-init

`/lr-init` sets up Looprch for a project once. Every answer is saved by a `looprch` command, so
later phases, new chats and other agents reuse it.

## What it does

1. **Readiness**: `looprch doctor --json` checks Node, Python, git, the central install, the
   project attachment, agent CLIs and logins, relays, QuotaLens, the SEV3 package and git. Fixes
   are offered, for example `looprch install-relay codex --yes`.
2. **SEV3 discovery and trust**: `looprch init discover` requires `phases/manifest.json` at the
   project root with `schema_version: sev3/1` and toolkit `1.2.0`, compares the package's
   `phases/tools/` with Looprch's trusted copy, runs the vendored `verify_package.py`, and records
   the package and source fingerprints.
3. **Gate acknowledgement**: the distinct gate commands (for example `python3 ×3`) are shown once.
   `looprch init ack-gates --manifest-sha256 <sha>` records your acknowledgement with the
   manifest hash. A changed manifest asks again.
4. **Roles**: for Planner, Plan Debater, Implementer, Tester, Reviewer and Worker you choose the
   agent, Direct or Delegate, the model (from `looprch models <agent>`, never invented), and
   optional effort, timeout and fallbacks.
5. **Validation**: `looprch config validate` must pass.

## Equivalent commands

```sh
looprch doctor
looprch init discover
looprch init ack-gates --manifest-sha256 <sha>
looprch config set lead_host cursor
looprch config set-role planner --mode direct --agent cursor --model <model>
looprch config set-role implementer --mode delegate --agent opencode --model provider/model --effort high --timeout 2h
looprch config add-fallback implementer --mode delegate --agent codex --model <model>
looprch config validate
```

Model names come from delegate-setup's discovery (`looprch models <agent>`), cached for 24
hours. If an agent cannot list its models, type the id its own CLI uses.
