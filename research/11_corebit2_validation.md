# CoreBit2 validation (0.7.x)

CoreBit2 (`/var/www/html/Corebit2`) is a fresh copy of the CoreBit SEV3 package (89 phases, same
`phases/` and `requirements/` as CoreBit), attached with Looprch and configured like CoreBit,
except that the Plan Debater is Kimi `kimi-code/k3`:

| Role | Agent / model | Fallbacks |
|---|---|---|
| Planner | codex `gpt-6-sol` | kimi `kimi-code/k3`, agy `gemini-3.8-flash-high` |
| Plan Debater | kimi `kimi-code/k3` | codex `gpt-6-sol` |
| Implementer | opencode `opencode-go/deepseek-v4.1-flash` | cursor `grok-4.7-high` |
| Tester | cursor `grok-4.7-high` | agy `gemini-3.8-flash-high` |
| Reviewer | codex `gpt-6-sol` | cursor `grok-4.7-high` |

Limits: `repair_rounds` 3, `review_rounds` 3, and the 0.7 defaults `debate_rounds` 3,
`readback_rounds` 2, `lineage_attempts` 2. E2E is not configured (P-001 has no UI). The Lead is a
Grok 4.7 subagent (`grok-4.7-high-fast`) running `/lr-phase` with host `cursor`. It answers only
the baseline question and stops after review round 1 and at every other decision. A pristine
copy is kept in `/tmp/corebit2-pristine.tar.gz`.

## Measured success criteria (from the 0.7 plan, compared with the CoreBit P-001 baseline)

| Criterion | Target | CoreBit P-001 (0.6.x) |
|---|---|---|
| Open readback items at approval | 0 | not measured (no readback) |
| Implementer `needs_context` caused by plan gaps | 0 | 0 requested, but the plan left closed rules open |
| Undeclared deviations | 0 | not measured |
| Round 1 findings with `cause: plan` | ≤ 2 | 1 recorded, while 14 of 16 were really design gaps |
| Round 2 `unfixed` findings | 0 | 7 |
| Review rounds to close | ≤ 2 | not closed after 2 |

## Run 1 (0.7.0): a Looprch defect at the first planning step

- 07:40 baseline committed; planner-1 (codex `gpt-6-sol`) ran for 2.8 min (53 k uncached input,
  555 k cached, 6 k output tokens). It returned `needs_expansion` for `.looprch/user-rules.md`.
- The package requires that file (`phases/AGENTS.md`: "Before execution read
  `.looprch/user-rules.md`"; `R-001.04`). It does not exist, and the brief said nothing. The
  Planner refused to assume its contents, which is the correct behavior.
- Looprch passed the path to the SEV3 toolkit as a document id, and the phase blocked with
  `config_invalid` and an empty hint.
- **Classification: orchestration defect** (an invalid expansion should be re-asked, not
  blocked; the absence of an optional Looprch file should be stated). Fixed in 0.7.1, tested,
  released, installed from GitHub, and CoreBit2 restored from the pristine copy before run 2. Run
  1 is not counted as a validation of 0.7.1.
