# Optional E2E testing (TesterArmy `e2e`)

Looprch can run end-to-end tests as an extra gate with the open-source TesterArmy runner
([tester.army/e2e](https://tester.army/e2e), npm package `e2e`, Apache-2.0). It is optional:
without it, nothing changes.

## What you need

- Node.js 24.8 or newer (22.22.3 or newer on Node 22).
- `e2e` and an engine in the project, for a web app `npm i -D e2e @e2e-dev/web` (Playwright
  downloads Chromium once).
- `e2e.config.ts` and at least one `tests/**/*.e2e.ts` test. `npx e2e init --yes` scaffolds
  both, and also adds its own agent skill and MCP entries.
- A model key only if tests use agent steps (`agent.act` replays from a cache after its first
  pass; `agent.assert`, `agent.waitFor` and `agent.extract` call the model every run). Tests with
  locators and `expect` need no model.

The hosted `testerarmy` cloud CLI is not supported: its browsers cannot reach `localhost`.

## Set it up

Run `/lr-e2e-test-init` in your agent (or answer yes to the E2E step of `/lr-init`). It checks the
runner, helps you write `e2e.config.ts`, and saves the setup with:

```bash
looprch e2e configure --config e2e.config.ts --timeout 20m --require-env AI_GATEWAY_API_KEY --enable
```

`configure` checks the Node version, `node_modules/.bin/e2e`, the config file, the required
environment variables (names only; values are never stored) and a dry run (`e2e list`) that must
select at least one test. Nothing is saved until every check passes.

Options: `--arg=<selection arg>` (repeatable: `--arg=--target --arg=web`, `--arg=--tag
--arg=smoke`), `--phases all|P-003,P-004`, `--env NAME=value`, `--bin <path>`.

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

The runner does not sandbox the app or the tests; they run with your environment
(`CI=1 E2E_TELEMETRY_DISABLED=1` are set by default).
