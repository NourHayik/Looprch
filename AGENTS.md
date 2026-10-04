# Working on Looprch itself

This file is for coding agents and humans changing the Looprch source. It is not the
AGENTS.md block Looprch writes into user projects.

## Ground rules

- Read `research/00_README.md` (decision log D-01 to D-22) before changing behavior.
- TypeScript, Node 22+, ESM. Build with `npm run build`; test with `npm test`; e2e with `npm run test:e2e`.
- No runtime dependencies. `@clack/prompts` is bundled into `dist/looprch.mjs` at build time.
- Every module maps to a component in `research/01_architecture.md` §4 (`fsx`, `config`, `state`,
  `journal`, `lifecycle`, `briefs`, `sev3`, `gates`, `delegate`, `quota`, `git`, `agents/<id>`,
  `install`, `ui`). No plugin framework, service layer or DI container.
- Imports go at the top of the module. No inline or dynamic imports.
- `switch` statements over unions or enums end with a `never` check in `default`.
- Never edit `vendor/sev3-toolkit/`: it is a byte-for-byte copy of SEV3 toolkit 1.2.0, checked by
  `vendor/sev3-toolkit/1.2.0/SHA256SUMS`.
- Never modify the SEV3 skill under `sev3/` (read-only design input, gitignored).
- Git is called through `execFile` only. Looprch never pushes, force-pushes, resets, rebases or
  stashes; a unit test scans `src/` for these.
- CLI JSON output is a stable interface used by the `/lr-*` skills. Add fields; do not rename them.
- Documentation is English only (`docs/user/`, `docs/dev/`).

## Layout

See `docs/dev/repository-structure.md`.
