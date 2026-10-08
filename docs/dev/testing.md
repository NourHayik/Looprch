# Testing

```sh
npm test            # build, then unit + integration (about 40 s)
npm run test:e2e    # build, then the notes-spec end-to-end scenarios (about 90 s)
npm run test:unit   # unit tests only
```

Tests are TypeScript under `test/`, compiled with `tsconfig.test.json` to `build/` and run by
`node --test`. Integration and e2e tests call the built CLI (`dist/looprch.mjs`).

## Isolation

`test/helpers/tmp.ts` `sandbox()` gives every test a temporary `HOME`, `LOOPRCH_HOME`, a `bin/`
directory first on `PATH`, a git identity through `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, an empty
global git config, and clears host environment markers (so tests behave the same inside an agent).

## Fakes

- `test/fixtures/fake-relay/relay.mjs`: speaks the relay CLI, writes `delegate-relay.result.v1`,
  and plays every role from the brief's machine-readable header. Behavior is scripted per
  `(agent, role, phase, task, nth)` by the JSON file in `LOOPRCH_FAKE_SCENARIO`: status
  (completed, failed, timeout, unavailable), decisions, `sleep_ms`, `kill_self`, `usage_error`,
  `no_session`, `read_only_violation`, `touch`, `omit_block`, `omit_new_file`, `variant`. The
  fake Planner returns a contract covering the phase's requirements (`drop_requirement`,
  `deferrals`, `contract` override it), dispositions every debate finding (`omit_dispositions`)
  and amends the contract for a repair design (`omit_amendment`, `contract_amendment`). The fake
  Implementer edits `noteapp.py` on review repairs (`no_change`, `resolution_status`). The fake
  Tester verifies every contract id and Delta finding (`verifications`, `omit_verifications`,
  `bad_tests`). The fake Reviewer adds `cause`, `## Coverage`, `contract_review` and `prior`
  (`raw_findings`, `omit_prior`, `prior`, `contract_review`, `omit_contract_review`). Calls are
  logged to `fake-calls.jsonl`.
- `test/fixtures/notes-impl/`: the application code and tests the fake Implementer and Tester
  write per phase (`buggy/` for a failing first attempt).
- `test/helpers/fakes.ts`: installs fake relays in `~/.agents/skills`, fake agent binaries and a
  fake `quotalens` reading `FAKE_QUOTA_FILE`.
- `test/helpers/lead.ts`: `setupProject()` (install, attach, roles, discovery, gate ack) and
  `drive()`, a scripted Lead (next → execute → record) used by integration and e2e tests.

## Suites

| Suite | Covers |
|---|---|
| unit | core (fsx, lock, journal, config, migrations, state), agents, sev3 helpers, gates and result parsers, briefs, quota policy, delegate argv/sessions/mode resolution, skills consistency, status rendering; protocol 4: contract executability, plan lint, dispositions that must change their refs, debate ledger, relay usage formats, the skip/focus scan, traceability, e2e config (`v07.test.ts`) |
| integration | install/update/rollback/uninstall, add/remove/list, SEV3 discovery and packets, git operations, doctor and config, lifecycle transition rows, delegate dispatch, status/log/review/worker, the optional e2e gate with a fake `e2e` CLI (`test/fixtures/fake-e2e/`: configure/enable/disable, pass, failing test → repair, exit 2/3/timeout/missing binary → blocked, no report → fail, disabled → no run) |
| e2e | E-1 to E-16 on notes-spec: happy path, repairs, cap, detached runs, interruption, spec change, quota wait and fallback, rate limits, read-only, re-asks, D-05, merge conflict, HEAD mismatch and pause. C-1 to C-17: the phase contract and convergence (uncovered requirements, debate dispositions, Plan-caused findings, violated obligations, contract_review coverage, false `fixed`, false `Verified` (missing testcase, or a stale testcase that already passed on the reviewed tree), per-check proofs, missing verifications, `related` variants, re-review consistency, `needs_design`, redesign with a design debate, deferrals across phases, a protocol-1 phase without a contract). 0.7.0: C-3b/C-3c the real debate (an accept that changes nothing is rejected, upheld items at the limit go to the user, contested items reach the Reviewer, lint and independent-risk items), C-19 chains and the readback, C-19b readback questions back to the Planner and the Debater, C-19c deviations, C-21 Reviewer repair packages, C-21b boundary routing and blueprints, C-21c `lineage_stuck`, C-8 gate caching |

No test makes paid model calls. The manual smoke checklist for real agents is in
[debugging.md](debugging.md).
