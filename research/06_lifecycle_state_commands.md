# 06 — Lifecycle, project state, commands, bootstrap

## 1. Phase state machine

```text
pending
 -> preflight          (lightweight checks; first phase also git init/baseline)
 -> planning           Planner (packet: planner)                         -> plan.md
 -> debating           Plan Debater, exactly one pass (read-only)        -> debate.md
 -> synthesizing       same Planner session, only if debate has findings -> plan.md (final)
 -> [approval: plan]   optional human stop (approvals.plan)
 -> implementing       Implementer                                       -> checkpoint commit
 -> testing            Tester writes/updates tests; Looprch runs gates   -> test-report.md, gates.json
      fail -> repairing(round n) Implementer same session -> testing      (cap: limits.repair_rounds)
 -> reviewing          Reviewer (read-only) on code + evidence           -> review.md
      changes_requested -> repairing -> testing (affected gates) -> reviewing
 -> handover           Implementer final handover; file list check       -> handover.md
 -> closing            todo.md ticks, final commit, [approval: merge], merge --no-ff, tag
 -> closed
```

Overlay flags on any stage: `paused`, `waiting {until, reason}`, `blocked {reason}`.
Repair cap exceeded → `blocked: repair limit` with a summary, user decides (`/lr-resume` with an
instruction, or edit config).

Routing (deterministic): debate findings → Planner; tester failures → Implementer; review
findings → Implementer, then Tester re-verifies affected gates, then Reviewer re-reviews; missing
cross-phase context raised by Implementer → Planner (expansion request), never invented.

## 2. Role output contract

Every role's final message ends with a fenced block the CLI parses:

````text
```looprch-result
{"role":"reviewer","decision":"changes_requested",
 "findings":[{"id":"R-1","severity":"high","summary":"…","files":["app/x.php"]}],
 "expansion_requests":[]}
```
````

Markdown above the block is saved as the stage artifact. Missing/invalid block → one automatic
re-ask in the same session, then blocked. Required fields per role are defined in
`schemas/role-results.schema.json`.

## 3. Project state

```text
.looprch/
  config.json        committed   see 04
  state.json         committed   schema_version, core_version_at_phase_start, protocol, spec
                                 {fingerprint, phases_total}, current {phase, stage, round, run_id},
                                 flags {paused, waiting, blocked}, sessions{}, assignments_history[],
                                 git {base_branch, baseline_commit}, phases {P-NNN: status, closed_at}
  events.jsonl       committed   append-only {ts, type, phase, stage, role, agent, run_id, data}
  phases/P-NNN/      committed   plan.md, debate.md, test-report.md, review.md, handover.md,
                                 gates.json, workers/*.md
  user-rules.md      committed   optional project rules; path included in every brief
  packets/ runs/ test-evidence/ reports/ backups/ lock      ignored
```

Writes: temp file + fsync + rename. Lock `.looprch/lock` `{pid, hostname, host_agent, started,
heartbeat}`; stale if the pid is dead on the same hostname; otherwise refuse and explain.
Interrupted run (state says running, process gone, no result) → `next` returns retry with the
same session if known; the stage checkpoint commit lets the user inspect partial work.

## 4. Commands

In-agent skills (all call the CLI; none hold state):

| Skill | Behavior |
|---|---|
| `/lr-init` | Bootstrap checks (`looprch doctor --json`), offer fixes/installs, SEV3 discovery/trust, gate command acknowledgement, role configuration conversation (persisted via `looprch config set-role`), git readiness (offer init now), summary |
| `/lr-doctor` | `looprch doctor` full report, explained |
| `/lr-status` | `looprch status` explained, next expected action |
| `/lr-phase` | Loop `next` → execute → `record` until the current phase is closed, then stop |
| `/lr-auto` | Same across phases; stops before the closure phase |
| `/lr-pause` | `looprch pause` (takes effect at the next step boundary) |
| `/lr-resume` | `looprch resume` then continue like `/lr-phase` or `/lr-auto` (remembers which) |
| `/lr-review [P-NNN]` | Independent read-only Reviewer run on a phase; writes `phases/P-NNN/reviews/adhoc-<ts>.md`; never changes closed status |
| `/lr-finish` | Runs the closure phase and final project closure |
| `/lr-worker <question>` | Read-only Worker; result in `phases/<current>/workers/`; advisory only |

Shell CLI:

| Command | Purpose |
|---|---|
| `install`, `update`, `rollback`, `uninstall`, `version`, `self-test` | Central installation (02) |
| `add [path]`, `remove <agent>`, `list` | Project attachment (03) |
| `doctor [--json] [--quick]` | Readiness checks |
| `status [--json]`, `log [--phase P-NNN] [-n N]` | Observability from the shell |
| `pause`, `resume` | Also usable outside the agent |
| `next`, `record`, `dispatch`, `gates run`, `config …`, `init …` | Agent-facing steps (documented, stable JSON) |

## 5. `/lr-init` bootstrap checklist

Detect → validate → install/configure (with confirmation) → report:

1. Node ≥ 22, Python ≥ 3.10, git present.
2. Looprch core integrity (`MANIFEST.sha256` of `current`), shim on PATH.
3. Project attached (`config.json`, links valid, AGENTS.md block present); not a 5.x layout.
4. Enabled agents: binaries on PATH, auth/model info via delegate-setup `discover.mjs` (cached).
5. delegate-skills: relay for every delegate role and fallback; version/hash; duplicate copies.
6. QuotaLens: present and readable (optional; recommend install if missing).
7. SEV3 package (05 §2).
8. Git: repo present? clean? (offer `git init` now; enforced at first phase).
9. `.gitignore` block present; `.looprch/` dirs exist.
10. Roles configured and valid.

## 6. Preflight before every phase (lightweight, < 2 s target)

Lock free; config/state schema current; protocol unchanged since phase start; spec fingerprint
unchanged; vendored toolkit hashes; binaries on PATH and relay files unchanged vs cache (no
`discover.mjs` rerun unless missing); QuotaLens reachable (non-blocking); git: repo exists, on
base branch, clean tree. First phase additionally performs `git init` and baseline (07).

## 7. Status example

```text
Looprch 0.1.0 · project corebit · spec 89 phases (fingerprint 0a13…)
Phase P-003 (3/89) "Tenant registry…"  stage: testing  repair round 1/3
Active: tester · codex · delegate · session 019a… · started 12:04 (6 min)
Last result: implementer completed · 14 files touched
Blockers: none          Next: run gates after tester report
```
