---
name: lr-e2e-test-init
description: Looprch - configure (or reconfigure) the optional TesterArmy e2e end-to-end test gate for this project, then enable or disable it. Use when the user runs /lr-e2e-test-init or asks to set up, change, enable or disable E2E testing.
---
# /lr-e2e-test-init

You set up the optional end-to-end gate. Looprch runs it with the open-source TesterArmy `e2e`
runner (https://tester.army/e2e, npm package `e2e`, Apache-2.0) after the SEV3 gates pass, and
judges it by the JUnit report `e2e` writes. Looprch works normally without it. Every choice is
persisted by a `looprch e2e` command; never edit `.looprch/config.json` yourself.

Facts to tell the user, in plain words:
- The tests are TypeScript files (`tests/**/*.e2e.ts` by default). Locator and assertion steps
  need no model. `agent.act` steps call a model once and then replay from a cache; `agent.assert`,
  `agent.waitFor` and `agent.extract` call the model on every run. The user pays that model.
- The runner needs Node.js 24.8+ (or 22.22.3+ on Node 22) and, for web apps, `@e2e-dev/web`
  (Playwright; it downloads Chromium once).
- It does not sandbox the app or the tests; it runs with the user's environment.
- The hosted `testerarmy` cloud CLI is a different product and is not supported: its browsers
  cannot reach `localhost`.

## 1. Current state

Run `looprch e2e status --json`. If it is configured, show the current settings and ask what to
change; the user may also only want `looprch e2e enable` or `looprch e2e disable` (then run it and
stop). If the user does not want E2E testing, stop: nothing is required.

## 2. The runner in the project

- Check `node --version` against the requirement above. If it is too old, say so and stop.
- If `node_modules/.bin/e2e` is missing, offer to install it: `npm i -D e2e @e2e-dev/web` (or the
  project's package manager). Run it only after the user confirms.
- If the project has no `e2e.config.ts`, offer `npx e2e init --yes` (only after the user
  confirms). Warn first that it writes `e2e.config.ts`, an example test, a `test:e2e` script,
  `.gitignore` entries, its own agent skill and MCP entries (`.mcp.json`, `.cursor/mcp.json`). The
  user may prefer to write `e2e.config.ts` with you instead.
- Ask how the app is reached: a URL of a running app, or a start command the runner launches
  (`app.command` with `executable`, `args`, `readyUrl`). Write or adjust `e2e.config.ts` with the
  user (it is the user's project file; show the diff first). Unknown config keys make e2e fail
  with `INVALID_CONFIG`; use only keys from the e2e config reference.
- Ask whether any test uses a model. If yes, ask which environment variable holds the key (for
  example `AI_GATEWAY_API_KEY` or `OPENROUTER_API_KEY`). Never ask for or store the value; the
  user exports it before running Looprch.
- There must be at least one `*.e2e.ts` test that the dry run selects.

## 3. Save

Run, with the answers:

`looprch e2e configure --config <path> [--timeout 20m] [--require-env <NAME>]... [--arg=<selection arg>]... [--phases all|P-003,P-004] [--enable] --json`

- `--arg=` takes selection arguments only, one per flag and with `=`: `--arg=--target --arg=web`,
  `--arg=--tag --arg=smoke`, or a test file.
- `--phases`: which phases run the gate (default all; a phase without a UI can be left out).
- `configure` checks the Node version, the binary, the config file, the required variables and a
  dry run (`e2e list`) that must select at least one test. On `ok: false`, explain each problem
  and fix it with the user, then run it again. Nothing is saved until it passes.

## 4. Finish

Tell the user:
- `looprch e2e enable` / `looprch e2e disable` turn the gate on and off at any time; the
  configuration is kept. `enable` refuses until `configure` has passed.
- With the gate enabled, Looprch runs it in the gating stage, only after every SEV3 gate passed,
  and not again on an unchanged tree. Failing e2e tests go to the normal repair round; a
  configuration error (exit 2), an environment failure (exit 3, timeout, missing binary) or a
  runner failure blocks the phase with a fix hint instead of a repair.
