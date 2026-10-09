# Optional E2E testing (TesterArmy `e2e`)

Looprch can run end-to-end tests as an extra gate with the open-source TesterArmy runner
([tester.army/e2e](https://tester.army/e2e), npm package `e2e`, Apache-2.0). It is optional:
without it, nothing changes.

## What you need

- Node.js 24.8 or newer (22.22.3 or newer on Node 22).
- A model key only if tests use agent steps (`agent.act` replays from a cache after its first
  pass; `agent.assert`, `agent.waitFor` and `agent.extract` call the model every run). Tests with
  locators and `expect` need no model.

The hosted `testerarmy` cloud CLI is not supported: its browsers cannot reach `localhost`.

## Set it up in three steps

1. Run `/lr-e2e-test-init` in your agent (or answer yes to the E2E step of `/lr-init`). It asks
   three things: which model provider, how the app is reached (a URL, or a start command such as
   `npm run dev`), and which phases. Then it runs one command, for example:

   ```bash
   looprch e2e init --provider openrouter --start "npm run dev" --url http://localhost:3000 --install --yes
   ```

   In a terminal you can also run `looprch e2e init` alone: it asks for each choice.

2. Open **`.env.e2e`** and paste your key after its `=`. The file lists every key the provider
   needs, each with a comment saying where to get it, and it is gitignored. A variable you export
   in your shell wins over the file.

3. Run `looprch e2e configure --enable`. It checks the Node version, the runner, the config, the
   keys and a dry run (`e2e list`) that must select at least one test, then turns the gate on.
   Nothing is saved until every check passes.

What `looprch e2e init` writes:

| File | Content |
|---|---|
| `e2e.config.ts` | the web target with your URL or start command, the provider's model in `agents.default`, and a line that loads `.env.e2e`; kept if it exists (`--force` replaces it and writes `e2e.config.ts.bak`) |
| `.env.e2e` | `APP_URL`, the provider's key(s) and `E2E_MODEL` (change the model here, without editing the config); a re-run only adds missing keys |
| `tests/e2e/smoke.e2e.ts` | a first test that needs no model, only when there is no `*.e2e.ts` test yet |
| `.gitignore` | `.env.e2e` |

With `--install` (or a yes in the terminal) it also installs `e2e`, `@e2e-dev/web` and the
provider's AI SDK packages with your package manager (npm, pnpm, yarn or bun, chosen by the lock
file).

| `--provider` | Package | Key in `.env.e2e` |
|---|---|---|
| `none` | none | none (locator tests only) |
| `openrouter` | `@openrouter/ai-sdk-provider` | `OPENROUTER_API_KEY` |
| `openai` | `@ai-sdk/openai` | `OPENAI_API_KEY` |
| `anthropic` | `@ai-sdk/anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `@ai-sdk/google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `deepseek` | `@ai-sdk/deepseek` | `DEEPSEEK_API_KEY` |
| `gateway` | `ai` (Vercel AI Gateway) | `AI_GATEWAY_API_KEY` |
| `openai-compatible` | `@ai-sdk/openai-compatible` (Ollama, vLLM, LM Studio, LiteLLM, a vendor API) | `E2E_BASE_URL`, optional `E2E_API_KEY` |

Every provider with a model also needs `ai` and `zod`, which `--install` adds. With
`--provider none`, nothing needs a key, so `looprch e2e init --provider none --enable --yes`
finishes the whole setup in one command.

`looprch e2e configure` takes more options for an existing setup: `--arg=<selection arg>`
(repeatable: `--arg=--target --arg=web`, `--arg=--tag --arg=smoke`), `--phases all|P-003,P-004`,
`--require-env NAME`, `--env NAME=value`, `--config <path>`, `--bin <path>`, `--timeout 20m`.

## Turn it on and off

```bash
looprch e2e enable     # refuses until configure has passed
looprch e2e disable    # keeps the configuration
looprch e2e status
```

The setting is per project (`.looprch/config.json`, `integrations.e2e`). `looprch doctor` reports
an enabled gate that cannot run.

## When it runs

In the gating stage, after every SEV3 gate passed, as gate `LR-E2E`:

```
node_modules/.bin/e2e run --config <config> --reporter list,junit --output <fresh dir> <args>
```

Looprch reads only the `junit.xml` of that run (a stopped run keeps the previous run's report, so
the directory is always fresh) and records the run in `gates.json`, where the Reviewer sees it.
It does not run again on a tree it already passed on, and it never runs when SEV3 gates fail.

| Result | What Looprch does |
|---|---|
| exit 0 and a passing report | the gate passes |
| exit 1 (tests failed), or exit 0 without a report | a failing gate: the normal repair round |
| exit 2 (configuration, collection, credentials) | `blocked e2e_config`: fix the setup, or `looprch e2e disable`, then `looprch resume` |
| exit 3 (app, engine or model provider), timeout | `blocked e2e_environment`: `looprch resume` runs the gates again |
| `node_modules/.bin/e2e` missing | `blocked e2e_missing` |
| exit 4 or a signal | `blocked e2e_runner` |

The runner does not sandbox the app or the tests; they run with your environment, the values of
`.env.e2e` (the shell wins over the file) and `CI=1 E2E_TELEMETRY_DISABLED=1`.
