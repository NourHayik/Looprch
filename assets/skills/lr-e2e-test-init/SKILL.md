---
name: lr-e2e-test-init
description: Looprch - set up (or change) the optional TesterArmy e2e end-to-end test gate in one step, then enable or disable it. Use when the user runs /lr-e2e-test-init or asks to set up, change, enable or disable E2E testing.
---
# /lr-e2e-test-init

You set up the optional end-to-end gate. Looprch runs it with the open-source TesterArmy `e2e`
runner (npm package `e2e`) after the SEV3 gates pass. Looprch works normally without it. One
command does the setup: `looprch e2e init`. Never edit `.looprch/config.json` yourself.

Tell the user in plain words:
- Tests are TypeScript files under `tests/`. Locator steps need no model and cost nothing. Agent
  steps (`agent.act`, `agent.assert`) call a model the user pays for.
- The runner needs Node.js 24.8+ (or 22.22.3+ on Node 22).

## 1. Current state

Run `looprch e2e status --json`. If it is configured, show the settings and ask what to change;
the user may only want `looprch e2e enable` or `looprch e2e disable` (run it and stop). If the
user does not want E2E testing, stop.

## 2. Three questions

1. **Model**: none (locator tests only), `openrouter`, `openai`, `anthropic`, `google`,
   `deepseek`, `gateway` (Vercel AI Gateway) or `openai-compatible` (Ollama, vLLM, LM Studio, a
   vendor API). Optional: a model id (each provider has a default).
2. **App**: is it already running at a URL, or should the runner start it with a command (for
   example `npm run dev`)? Ask for the URL either way (default `http://localhost:3000`).
3. **Phases**: all phases (default), or only the phases with a UI (for example `P-003,P-004`).

Never ask for the API key in the chat: the key goes into a file only the user edits.

## 3. Run the setup

`looprch e2e init --provider <id> [--model <id>] [--url <url>] [--start "<command>"] [--base-url <url>] [--phases all|P-003,P-004] --install --yes --json`

Ask before adding `--install` (it runs the project's package manager to add `e2e`,
`@e2e-dev/web`, and the provider's AI SDK packages). It writes `e2e.config.ts` (kept if one
exists; `--force` replaces it and writes a `.bak`), `tests/e2e/smoke.e2e.ts` when there is no
test yet, and **`.env.e2e`**: every key the provider needs, each with a comment saying where to
get it. `.env.e2e` is added to `.gitignore`.

## 4. The keys

If `missing_keys` is not empty, show the user the `next` lines: open `.env.e2e`, paste each key
after its `=`, save. A key already exported in the shell also works and wins over the file. When
the user says it is done, run `looprch e2e configure --enable --json`. On `ok: false`, explain
each problem and fix it with the user, then run it again.

## 5. Finish

Tell the user:
- `looprch e2e enable` / `looprch e2e disable` turn the gate on and off; the setup is kept.
- With the gate enabled, Looprch runs it after every SEV3 gate passed, not again on an unchanged
  tree. Failing e2e tests go to the normal repair round; a setup problem (a missing key, the app
  not starting) pauses the phase with a fix hint.
