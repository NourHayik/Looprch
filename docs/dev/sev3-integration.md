# SEV3 integration

Looprch consumes package schema `sev3/1`, toolkit `1.2.0`. SEV3 itself is never modified.

## Vendored toolkit

`vendor/sev3-toolkit/1.2.0/` holds the five files byte-for-byte (`sev3lib.py`, `specctl.py`,
`phase_context.py`, `verify_package.py`, `VERSION`) and `SHA256SUMS`. Looprch always runs this
copy: `python3 -B <vendor>/<tool>` with `PYTHONDONTWRITEBYTECODE=1` (no bytecode in the
immutable install).

## Discovery and trust (`looprch init discover`)

1. `phases/manifest.json` at the project root with `schema_version: sev3/1`; a package found in
   a subfolder gets a specific error (v1 needs it at the root, D-16).
2. Unknown `toolkit_version` → "update Looprch".
3. `phases/tools/<5 files>` and `phases/tooling-lock.json` must match `SHA256SUMS`;
   `__pycache__/` is ignored, other extra files are reported.
4. Readability of every referenced file (mode-600 files of another uid are named).
5. Vendored `verify_package.py --root <project>` must return `ok: true`. Its
   `application_verified: false` is never presented as application verification.
6. Fingerprints: **package fingerprint** = `phases/package-lock.json` → `fingerprint`, read
   only after verify passed (verify checks the lock); **source fingerprint** =
   `specctl.py fingerprint`. Both are stored in `state.json`.
7. Gate commands (distinct `argv[0]` with counts) and the manifest sha256 for the acknowledgement.

## Packets

`phase_context.py --root <project> --phase P-NNN --role <role> --output .looprch/packets/P-NNN/<role>.md`.
Roles: planner, plan-debater, implementer, tester, reviewer (the Worker has no packet). The
packet is referenced from the brief, never inlined or truncated. Expansion requests run with
`--include-document` / `--include-phase` plus `--question` and `--reason` into
`<role>-exp-<n>.md`, are journaled (`expansion.executed`) and change no scope. Implementer
requests go to the Planner (the toolkit refuses implementer expansions).

## todo.md

`src/sev3/todo.ts` flips exactly one `[ ]` to `[x]` on the line for a key
(`P-NNN`, `P-NNN:implementation`, `P-NNN:gate:<id>`, `P-NNN:independent-test`,
`P-NNN:independent-review`, `P-NNN:handover`, `PROJECT:production-readiness`) and never edits
anything else. `todo.md` is outside the package lock, so ticking keeps the package verified.

## Freshness

Every preflight re-verifies and compares the package fingerprint; every packet build validates
again. A change blocks with `spec_changed`. `looprch init discover --accept-fingerprint` accepts
a resealed amendment; closed phases and their evidence are never rewritten.

## Gates

Argv only, no shell, `cwd` the project, `timeout_seconds` (default 300), env plus
`config.gates.env` and `PYTHONDONTWRITEBYTECODE=1`. Evidence: `unittest` ("Ran N tests" N > 0, final
`OK`, exit 0, not all skipped), `junit` (non-skipped testcases > 0, no failing or erroring
testcases, suite counters 0, evidence file newer than the run), `none` (exit 0; never for
test/integration/negative gates), `manual` (exit 0 plus an inspection report). Results in
`gates.json` with argv, exit, duration, counts, evidence sha256 and the tested tree hash. A
gate's `requirements[]` is not treated as proof of each id.
