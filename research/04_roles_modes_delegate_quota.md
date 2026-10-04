# 04 — Roles, Direct vs Delegate, delegate-skills, sessions, QuotaLens

## 1. Roles

Lead (the host agent running `/lr-*`), Planner, Plan Debater, Implementer, Tester, Reviewer, Worker.
SEV3 rules: one Plan Debate pass then same-Planner synthesis; one sequential Implementer writes
application code, not tests; Tester owns test code and gates; Reviewer checks actual code and
evidence; Lead never substitutes for a role. Worker is read-only, advisory, never normative, never
satisfies a gate (max parallel Workers default 3).

## 2. Config shape (`.looprch/config.json`, excerpt)

```json
{
  "schema_version": 1,
  "lead_host": "cursor",
  "agents": ["cursor", "codex", "opencode", "kimi"],
  "roles": {
    "planner":      { "mode": "direct",   "agent": "cursor",   "model": "<from discovery>",
                      "fallbacks": [{ "mode": "delegate", "agent": "codex", "model": "<…>" }] },
    "plan_debater": { "mode": "delegate", "agent": "kimi",     "model": "<…>" },
    "implementer":  { "mode": "delegate", "agent": "opencode", "model": "<provider/model>", "effort": "high",
                      "timeout": "2h", "fallbacks": [{ "mode": "delegate", "agent": "codex", "model": "<…>" }] },
    "tester":       { "mode": "delegate", "agent": "codex",    "model": "<…>" },
    "reviewer":     { "mode": "direct",   "agent": "cursor",   "model": "<…>" },
    "worker":       { "mode": "delegate", "agent": "codex",    "model": "<…>", "max_parallel": 3 }
  },
  "limits": { "repair_rounds": 3, "quota_wait_minutes": 60 },
  "approvals": { "plan": "never", "merge": "never" },
  "git": { "phase_branches": true }
}
```

Validation: a `direct` role's agent must equal `lead_host`; agents must be enabled; delegate
roles need an existing relay; read-only roles (plan_debater, reviewer, worker) assigned to an agent
whose relay read-only is `none` produce a warning (Looprch still checks git status before/after).
Model ids are never invented: they come from discovery or the user's explicit entry.

## 3. Mode resolution at dispatch time

```text
role config (mode, agent, model)
  mode == direct and agent == current host      -> Direct (native subagent, brief file)
  mode == direct and agent != current host      -> Delegate via <agent>-delegate, same model,
                                                   status shows "direct→delegate (host is <x>)"   [D-05]
                                                   if relay or CLI missing -> blocked with message
  mode == delegate                               -> Delegate via <agent>-delegate
then apply quota policy (section 6) which may pick a fallback entry
```

Current host is reported by the skill (each skill passes `--host <id>` to `looprch next`).

## 4. Delegate dispatch (`looprch dispatch <run_id>`)

```text
node <relay> --brief .looprch/runs/<run_id>/brief.md --cd <project>
     --out-dir .looprch/runs/<run_id>/relay [--model M] [--effort E | --variant E]
     [--read-only] [--session <id> | --conversation <id>] [--timeout T] [--clean-env if supported]
```

- Relay location: project `.agents/skills`, then `~/.agents/skills`, then `~/.codex/skills`,
  then other known global dirs. Resolved path + version + hash are cached machine-locally
  (never in project config). Differing duplicate copies → doctor warning naming the chosen one.
- Result: read `result.json` (`schema: delegate-relay.result.v1`): `status`, `exitCode`, session id
  field per adapter, `finalMessage`, `touchedFiles`, `readOnlyViolation` if present. Archive the
  whole relay out-dir under `.looprch/runs/<run_id>/` (ignored).
- Statuses `failed`/`timeout`/`aborted`/`*_unavailable` → recorded; lifecycle decides retry,
  resume or fallback. Exit code 2 with no result file = usage error → blocked (Looprch bug).
- Lanes (`--lane`) are not used [D-15].
- delegate-skills is never bundled. Missing relay → `/lr-init` offers
  `npx skills add amElnagdy/delegate-skills -g --skill <x>-delegate` after confirmation (exact flags
  verified at implementation).
- Env hygiene: `--clean-env` only on relays that support it (codex, commandcode); documented as a
  limitation for others.

## 5. Sessions

- Key: `(phase, role, agent)` in `state.json.sessions` with `{session_id, mode, resumable,
  created_at, last_used, runs[]}`.
- Repairs (tester failures, review findings, debate feedback to Planner) resume the same session
  with a delta brief. Resume failure or non-resumable adapter → new session with the full packet
  plus prior outputs (SEV3: a session id alone does not prove retained context).
- Each phase starts new sessions; knowledge crosses phases only through closed handovers.
- Direct sessions: stored if the host returns a resumable id (e.g. Cursor subagent id), otherwise
  `resumable: false`.

## 6. QuotaLens policy [D-07]

Interface (`quotalens status --json`, schema `1.0`): `providers[]` each with `id`, `installed`,
`auth_state`, `usage_capability`, `status` (`ok`, `timeout`, …), `stale`, `limits[]` each with
`id`, `category` (`rolling_window`, `weekly`, `credit`, …), `remaining_percent`, `resets_at`,
`reset_countdown_seconds`.

Before each role attempt (cache the JSON for 60 s):

```text
p = adapter.quotalensProvider
if QuotaLens missing, p unknown, provider stale/timeout/unknown  -> attempt (unknown is allowed)
exhausted = limits with remaining_percent == 0 (credit categories ignored)
if none exhausted -> attempt
reset = max(resets_at of exhausted limits)
if reset - now <= quota_wait_minutes (60) -> state "waiting until <reset>" (durable; next returns wait)
else -> next approved fallback in role.fallbacks (also checked); none left -> wait until reset
```

A relay failure classified as rate-limit (stderr/finalMessage patterns per adapter) marks that
provider exhausted with unknown reset → fallback if available, else wait with 15-minute retries,
then pause after 4 h and ask the user.

Implementer or Tester switching agent mid-phase (user chose the same rule for all roles):
1. Checkpoint commit of the current working tree on the phase branch (so contributions are
   separable).
2. New agent starts a fresh session with: full role packet, approved plan, `git diff` vs phase
   base, previous runs' final messages, open findings.
3. `state.json` records role assignment history; the final handover lists every contributing
   Implementer (core requirement 11: individually traceable).
