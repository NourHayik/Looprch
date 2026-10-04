# Looprch enhancement ideas

Ideas that are not in the original requirements but materially improve reliability, usability,
recoverability or observability. Each is marked **Now** (include in v1) or **Later**.
Technical details: `research/`.

---

## 1. Deterministic step engine (`looprch next` / `looprch record`) — Now

**Problem.** If the Lead (an LLM inside the host agent) keeps the workflow state in its own
context, long runs lose their place after context compaction, a new chat or a restart. Earlier
Looprch versions tried to fix this with long governance prompts.

**Enhancement.** The CLI owns the phase state machine. `looprch next` returns exactly one next
action (role, mode, agent, brief, session). The Lead performs it and reports back with
`looprch record`.

**Why it helps.** Any restart, any new chat or a different host agent continues by running
`looprch next`. Behavior is predictable and testable without AI.

**Complexity.** Medium. It replaces logic that would otherwise live in prompts.

## 2. Repair-round cap with escalation — Now

**Problem.** Test → fix → test and review → fix → review loops can run indefinitely and burn
usage.

**Enhancement.** A per-phase limit (default 3 rounds). When exceeded, the phase becomes
`blocked: repair limit` with a summary of the remaining failures, and the user decides.

**Why it helps.** Bounded cost and a clear human decision point.

**Complexity.** Low.

## 3. Context-size guard — Now

**Problem.** SEV3 packets vary from about 100 KB to 920 KB (Corebit P-089) and must never be
truncated. A packet larger than the assigned agent's context leads to silent quality loss.

**Enhancement.** Compare the packet size with the agent/model's configured budget before
dispatch. Warn, and suggest an approved fallback with a larger budget.

**Why it helps.** Prevents a class of failures that are hard to detect afterwards.

**Complexity.** Low.

## 4. Shell-side status and log — Now

**Problem.** The only way to see progress would be to open an agent session and ask.

**Enhancement.** `looprch status` (current phase, stage, role, agent, session, last result,
blockers, next action) and `looprch log` (journal view), both with `--json`.

**Why it helps.** Observability from any terminal, scriptable, and no tokens spent.

**Complexity.** Low.

## 5. Run archive — Now

**Problem.** When a delegated run misbehaves, the brief, raw output and stderr are lost in temp
directories.

**Enhancement.** Keep every dispatch's brief, `result.json`, event stream and stderr under
`.looprch/runs/<run-id>/` (gitignored).

**Why it helps.** Debugging and recovery without re-running anything.

**Complexity.** Very low.

## 6. One brief for Direct and Delegate — Now

**Problem.** Separate prompt paths for native subagents and delegated CLIs drift apart over time.

**Enhancement.** The CLI assembles one brief file (role template, packet path, task, prior
findings, output contract). Direct and Delegate differ only in how the brief is delivered.

**Why it helps.** One place to change role behavior. Core updates apply to every agent without
regenerating per-agent files.

**Complexity.** Low.

## 7. Gate-command acknowledgement — Now

**Problem.** SEV3 gates are commands Looprch executes on your machine (Corebit uses `php`,
`npm`, `composer`, `npx`). A changed or unexpected spec could run anything.

**Enhancement.** `/lr-init` shows the distinct gate commands once and records your
acknowledgement together with the manifest hash. A changed manifest requires acknowledgement
again.

**Why it helps.** Basic supply-chain safety at almost no cost.

**Complexity.** Low.

## 8. Lightweight preflight before every phase — Now

**Problem.** The environment can change between phases, not only between `/lr-init` and the
first phase.

**Enhancement.** A preflight that runs in under 2 seconds before each phase: lock,
schema/protocol versions, spec fingerprint, toolkit hashes, binaries and relays present, git
clean and on the base branch. Expensive discovery stays cached.

**Why it helps.** Failures surface before work starts, not in the middle of a phase.

**Complexity.** Low.

## 9. Stage checkpoint commits on the phase branch — Now

**Problem.** An interrupted or failed implementation can leave half-applied changes with no
clear restore point.

**Enhancement.** Looprch commits on `looprch/P-NNN` at stage boundaries: plan approved,
implementation, each repair round, and agent switch. The base branch only receives the final
`--no-ff` merge.

**Why it helps.** Exact recovery points, clear diffs per stage, traceable contributions when an
Implementer is switched by a usage-limit fallback.

**Complexity.** Low.

## 10. Optional human approval stops — Now (off by default)

**Problem.** For high-risk phases you may want to read the plan, or the final diff, before
Looprch continues.

**Enhancement.** Config `approvals.plan` and `approvals.merge`: `never` (default), `high-risk`
(phases with risk high or critical), or `always`.

**Why it helps.** Human control exactly where it matters, without slowing normal runs.

**Complexity.** Low.

## 11. Fully headless runner — Later

**Problem.** Long unattended runs still need an open agent session acting as Lead.

**Enhancement.** `looprch auto --headless`: the CLI drives the whole loop itself, with every
role in Delegate mode.

**Why it helps.** Overnight or CI-style runs. It becomes simple once idea 1 exists.

**Complexity.** Medium.

## 12. Per-project core version pinning — Later

**Problem.** A project in a critical stage may need to stay on a known Looprch version while
other projects update.

**Enhancement.** Optional `core_version` in `config.json`; the shim runs that version from
`~/.looprch/versions/`.

**Why it helps.** Stability for sensitive projects.

**Complexity.** Low to medium. Not needed until real multi-project use shows the need.
