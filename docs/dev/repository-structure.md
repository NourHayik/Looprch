# Repository structure

```text
package.json          name "looprch", bin dist/looprch.mjs, engines node>=22, no runtime deps
tsconfig.json         strict type check (noEmit)
tsconfig.test.json    emits src/ and test/ to build/ for node --test
install.sh            curl | sh entry: checks prerequisites, runs npx looprch@<v> install
scripts/bundle.mjs    esbuild: src/cli/main.ts + @clack/prompts -> dist/looprch.mjs
scripts/build-manifest.mjs  writes VERSION and MANIFEST.sha256
src/
  cli/        one file per command or command group; main.ts dispatches
  core/       constants, errors, paths, fsx, lock, journal, config, migrations, state, runs,
              lifecycle, preflight, mode, actions, results, briefs, clock, validate
  sev3/       discovery, trust, fingerprint, packets, todo, toolkit, manifest
  gates/      runner, unittest, junit
  delegate/   locate, discover, dispatch, result, sessions
  quota/      quotalens, policy
  git/        git, baseline, phase, snapshot
  agents/     codex, cursor, agy, kimi, hermes, opencode, grok, index, types
  install/    central, manifest, shim, registry, links, project-files
  ui/         prompts (@clack/prompts)
assets/
  skills/lr-*/SKILL.md   the ten /lr-* skills (linked or copied into projects)
  roles/*.md             role texts used in briefs
  templates/             brief.md, handover.md, agents-md-block.md
vendor/sev3-toolkit/1.2.0/   byte-identical SEV3 toolkit + SHA256SUMS (never edit)
schemas/      config, state, events, gates, role-results JSON Schemas (documentation + tests)
test/
  unit/ integration/ e2e/    node:test suites
  helpers/    sandbox (temp HOME/LOOPRCH_HOME), fakes, lead driver, package builder
  fixtures/   notes-spec (SEV3 example copy), notes-impl (scripted code), fake-relay, quotalens, spike
docs/user/ docs/dev/
```

Generated, not committed: `dist/`, `build/`, `VERSION`, `MANIFEST.sha256`, `*.tgz`.
The npm package ships `dist/ assets/ vendor/ schemas/ install.sh VERSION MANIFEST.sha256` and the
README, LICENSE and CHANGELOG.
