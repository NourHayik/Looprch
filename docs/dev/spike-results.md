# Verification spike results

Spikes are defined in the implementation plan (section 3) and `research/09` §2. Each entry has
the date, the versions involved, what was run, the evidence, and the resulting adapter values.
Status values: **VERIFIED** (evidence below), **FALSE** (checked; the fallback is applied),
**NOT RUN** (needs an interactive agent session, paid quota or an agent that is not installed;
the documented fallback is applied until someone runs it).

Machine: Linux, Node 24.21.0, Python 3.14.4, git 2.x, 2026-10-03.
Agent CLIs: codex-cli 0.156.1, cursor-agent 2026.09.18-9a7762b, agy 1.2.16, kimi 2.1.1,
opencode 1.18.32 (snap), hermes (installed), quotalens 1.0.0. grok: not installed.
delegate-skills relays 0.5.0 in `~/.agents/skills` (a second, differing copy in `~/.codex/skills`).

## Summary

| Spike | Status | Effect on Looprch |
|---|---|---|
| S-1 symlinked skill discovery | NOT RUN (needs interactive sessions) | `followsSymlinks: "unverified"` for cursor, agy, kimi, hermes, grok, so `.agents/skills` is written in **copy mode** whenever one of them is enabled. Codex and OpenCode are documented to follow links. |
| S-2 invocation syntax and env markers | PARTIAL | Cursor env markers VERIFIED (`CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`). Invoke syntax for all agents stays as researched and is marked unverified in doctor. |
| S-3 Direct subagent files | NOT RUN | Direct enabled only for codex, cursor and opencode (researched file locations); agy, kimi, grok and hermes are Delegate-only or Lead-only. |
| S-4 exact-session resume | NOT RUN (paid) | Adapters declare resumable per relay documentation (`--session` / `--conversation`). Any resume failure falls back to a fresh session with the full packet. |
| S-5 read-only behavior | NOT RUN (paid) | Values from the relay sources: codex enforced (sandbox), cursor enforced (plan mode), opencode enforced (plan agent), agy and grok best-effort (`readOnlyViolation`), kimi none. Git checks always apply. |
| S-6 discover.mjs | VERIFIED | Output schema `delegate-discover.v1`; models under `models.values[]`; runtime 17.2 s, so discovery is cached for 24 h and never runs at preflight. |
| S-7 QuotaLens ids, rate-limit text | VERIFIED (ids), PARTIAL (text) | Provider ids: codex, cursor, kimi, antigravity, opencode. No rate-limit wording exists in the relay sources; Looprch matches generic CLI wording (`rate limit`, `429`, `quota exceeded`, `usage limit`, `too many requests`). |
| S-8 clack multiselect UX | NOT RUN (needs a human at a terminal) | Keep `@clack/prompts`; the non-interactive path (`--agents ... --yes`) is the tested path. |
| S-9 skills CLI flags | VERIFIED | `DISABLE_TELEMETRY=1 npx -y skills add amElnagdy/delegate-skills -g -y --copy --agent codex --skill <x>-delegate` installs into `~/.agents/skills/<x>-delegate/`, exit 0. |
| S-10 preflight cost, dispatch from a sandbox | VERIFIED | `verify_package.py` on Corebit (89 phases, 1,074 requirements): 0.87 s; notes-spec: 0.09 s. Preflight stays under the 2 s target including verification. Detached dispatch from the Cursor agent shell works (fake relay, e2e). |
| S-11 TesterArmy `e2e` runner | VERIFIED | Exit codes, JUnit path and dry run as below; the optional `LR-E2E` gate. |
| S-12 e2e providers and keys file | VERIFIED | Seven provider presets for `looprch e2e init`; `.env.e2e` loaded by the config; keys checked before saving. |

## S-2: invocation syntax and host environment markers

Run inside the Cursor agent shell on 2026-10-03 (`env | cut -d= -f1`):

```text
CURSOR_AGENT
CURSOR_CONVERSATION_ID
CURSOR_EXTENSION_HOST_ROLE
CURSOR_WORKSPACE_LABEL
VSCODE_PID
```

Resulting `envMarkers`: cursor = `CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`. Markers for the other
hosts are taken from their documentation where known (`CODEX_SANDBOX`, `CODEX_THREAD_ID` for
Codex; `OPENCODE` for OpenCode) and are treated as hints only: `looprch next --host` remains
required, and a conflict between the declared host and an env-detected host produces an
`ask_user host_conflict` action rather than a silent choice.

Invoke syntax used (unverified, printed by `looprch add`): codex `$lr-init`, cursor `/lr-init`,
agy `/lr-init`, kimi `/skill:lr-init`, hermes `/lr-init`, opencode `/lr-init` (command shim in
`.opencode/commands/`), grok `/lr-init`.

## S-6: discover.mjs

```text
$ time node ~/.agents/skills/delegate-setup/scripts/discover.mjs
17.24 s
version: delegate-discover.v1
codex     codex-cli 0.156.1  authenticated  models reported (9)
opencode  1.18.32            authenticated  models reported (106)
agy       1.2.16             auth unknown   models reported (18, "id<TAB>label" lines)
kimi      2.1.1              authenticated  models unsupported
cursor    2026.09.18-9a7762b authenticated  models reported (200, truncated)
missing: claude cline commandcode grok qoder vibe pi omp aider copilot warp zcode
```

Parser: `discovered[].{key, binary, version, path, authenticated, supports[], models{status, values[], truncated}}`.
agy values are split on the first tab; the first column is the model id.

## S-7: QuotaLens

`quotalens status --json` (schema `1.0`, about 10 s): providers `codex`, `kimi` (timeout, stale),
`antigravity` (timeout, stale), `cursor`, `opencode`. Limit categories seen: `rolling_window`,
`weekly`, `monthly`, `credit`, `other`; `remaining_percent` can be `null`. Looprch counts a
limit as exhausted only when `remaining_percent === 0` in `rolling_window`, `weekly` or
`monthly`. The captured output is the test fixture `test/fixtures/quotalens/status-2026-10-03.json`.

## S-9: skills CLI

`npx skills add --help` lists `-g/--global`, `-a/--agent`, `-s/--skill`, `-y/--yes`, `--copy`.
Without `--agent`, the CLI also tries every known agent and reports a failure for agents
without global install support (seen: "PromptScript does not support global skill
installation"). With `--agent codex` the install is clean, exit 0, and the relay lands in
`~/.agents/skills/<x>-delegate/scripts/relay.mjs`, the first global directory Looprch searches.

## S-10: costs

```text
verify_package.py --root /var/www/html/Corebit         0.87 s   ok, 89 phases
verify_package.py --root sev3/examples/notes-spec      0.09 s   ok, 3 phases
```

Both were run with `python3 -B` and `PYTHONDONTWRITEBYTECODE=1` from the vendored copy.

## S-11: TesterArmy `e2e` 0.18.0 (optional E2E gate)

Run on 2026-10-08 in `/tmp/e2e-spike` (Node 24.21.0, `e2e@0.18.0`, `@e2e-dev/web`, Chromium
already in the Playwright cache). The app was a static page served by the runner itself through
`app.command` (`python3 -m http.server`); the tests used locators only, so no model was needed.
Every command ran with `CI=1 E2E_TELEMETRY_DISABLED=1`.

| Case | Command | Exit | Output |
|---|---|---:|---|
| dry run | `e2e list --reporter json` | 0 | `{"pairs": [{file, title, target, disposition}]}` on stdout |
| passing test | `e2e run --reporter list,junit --output out1` | 0 | `out1/junit.xml` (`<testcase name="home shows ready [web]" classname="tests/pass.e2e.ts">`), `out1/report.json` |
| failing test | same, one test fails | 1 | `junit.xml` with one `<failure>`, `testsuites failures="1"` |
| invalid config (unknown key) | same | 2 | no output directory written |
| app command cannot start | same | 3 | no output directory written |
| empty selection (`--grep nomatch`) | same | 2 | `NO_TESTS`, no output |
| package missing | `npx --no-install e2e --version` in a project without it | 1 | npm error, no `node_modules/.bin/e2e` |

Consequences for Looprch:

- A run that stops before its tests keeps the **previous** run's `junit.xml`. Looprch passes a
  fresh `--output` directory per gate run and never reads a report it did not see written.
- Looprch runs `node_modules/.bin/e2e` directly (never `npx`, which may download).
- Exit 0 and 1 are test verdicts (JUnit is the evidence); 2 is configuration (the user must fix
  it); 3 is the environment; 4 and 130 are runner failures.
- The cloud `testerarmy` CLI was not tested: its browsers cannot reach `localhost`.

Looprch's own gate code was then run against the same real binary (`checkE2e` and `runE2eGate`
from the 0.7.0 build): configure check ok (`e2e 0.18.0`, 1 test); passing run → `pass`, exit 0,
1 testcase; with the failing test enabled → `fail`, exit 1, 2 testcases, 1 failure; `--grep
nomatch` → `config` (exit 2); a missing config file → `config` before running; timeout 1s →
`environment` ("timed out after 1s").

## S-12: e2e model providers and the keys file (`looprch e2e init`)

Run on 2026-10-09 in `/tmp/e2e-spike` (Node 24.21.0, `e2e@0.18.0`, `@e2e-dev/web`, `ai@7.0.136`,
`zod@4`). The provider list and versions come from the runner's own `e2e init` presets
(`dist/cli/init/gateways.js`, `scaffold.js`): agent steps need `ai@^7.0.0` and `zod@^4.1.8` plus
the provider package, and `agents.default.model` is a constructed AI SDK instance.

Each row below was written as `e2e.config.ts` with
`if (existsSync('.env.e2e')) process.loadEnvFile('.env.e2e');` at the top and the model in
`agents.default`, then run without any key in the environment: `e2e list --reporter json` and a
locator-only `e2e run`.

| Provider | Package | Model line | Key | list | run |
|---|---|---|---|---:|---:|
| gateway | `ai` | `gateway('openai/gpt-6-luna-fast')` | `AI_GATEWAY_API_KEY` | 0 | 0 |
| openrouter | `@openrouter/ai-sdk-provider@^3.0.0` | `openrouter('openai/gpt-6-luna-fast')` | `OPENROUTER_API_KEY` | 0 | 0 |
| openai | `@ai-sdk/openai@^4.0.0` | `openai('gpt-6-luna')` | `OPENAI_API_KEY` | 0 | 0 |
| anthropic | `@ai-sdk/anthropic@^4.0.0` | `anthropic('claude-sonnet-5')` | `ANTHROPIC_API_KEY` | 0 | 0 |
| google | `@ai-sdk/google@^4.0.0` | `google('gemini-3-flash')` | `GOOGLE_GENERATIVE_AI_API_KEY` | 0 | 0 |
| deepseek | `@ai-sdk/deepseek@^3.0.0` | `deepseek('deepseek-chat')` | `DEEPSEEK_API_KEY` | 0 | 0 |
| openai-compatible | `@ai-sdk/openai-compatible@^3.0.0` | `createOpenAICompatible({ name, baseURL: process.env.E2E_BASE_URL, apiKey: process.env.E2E_API_KEY }).chatModel(id)` | `E2E_API_KEY`, `E2E_BASE_URL` | 0 | 0 |

Further findings:

- No provider reads its key when the config loads: without a key, the config still loads and
  locator-only tests pass. The first agent step fails with `MODEL_PROVIDER_FAILED` (exit 3, an
  environment failure), so Looprch checks the keys file before it saves the configuration.
- `process.loadEnvFile('.env.e2e')` works inside `e2e.config.ts`, and a variable already exported
  in the shell wins over the file. An empty `NAME=` line sets an empty string.
- Without `.env.e2e` the guarded `existsSync` line skips loading and the run is unchanged.

## Spikes still to run (manual, with your go-ahead)

Use a throwaway repository `/tmp/lr-spike-<agent>` and the skill in
`test/fixtures/spike/lr-spike/SKILL.md`, which prints `LR-SPIKE-OK-<host>`.

1. S-1: `looprch add /tmp/lr-spike-<agent> --agents <agent> --yes` in symlink mode
   (`LOOPRCH_FORCE_SYMLINK=1`), then ask the agent to run `lr-spike`. Token printed → set
   `followsSymlinks: true` in `src/agents/<agent>.ts`.
2. S-3: configure a Direct role and ask the host to run `lr-planner` with
   `test/fixtures/spike/brief-tiny.md`; record the model reported and any returned id.
3. S-4 and S-5: `node <relay> --brief test/fixtures/spike/brief-tiny.md --cd /tmp/lr-spike-<agent>`
   then resume with `--session` / `--conversation`; repeat with `--read-only` and a brief that
   asks for a file to be created.
4. S-8: run `looprch add /tmp/x` in GNOME Terminal, tmux, the Cursor terminal and macOS Terminal.
