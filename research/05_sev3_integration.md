# 05 — SEV3 integration

SEV3 is read-only. Looprch consumes package schema `sev3/1`, toolkit `1.2.0`
(see `../sev3/references/package-contract.md`, `context-design.md`, `assets/package/phases/*.md`).

## 1. Package shape Looprch relies on

| Path | Use |
|---|---|
| `phases/manifest.json` | Single source: `project`, `documents[]`, `phases[]` (`id` `P-NNN`, `number`, `title`, `kind` implementation/closure/documentation, `risk`, `work_class`, `requires`, `owns`, `uses`, `related`, `requirements`, `gates`, `research`) |
| `phases/en/P-NNN.md` | Phase source with seven marked sections |
| `phases/context/en/P-NNN.md` | Generated context view (not task scope) |
| `phases/todo.md` | The only mutable tracker. Lines: `- [ ] P-NNN - title`, nested `P-NNN:implementation`, `P-NNN:gate:<GATE-ID>`, `P-NNN:independent-test`, `P-NNN:independent-review`, `P-NNN:handover`, final `PROJECT:production-readiness` |
| `phases/tools/` | Must match Looprch's vendored copy byte-for-byte |
| `phases/package-lock.json`, `tooling-lock.json`, `refinement.json` | Seal, toolkit hashes, attestation |
| `requirements/registry.json` + `requirements/en|ar/**` | Requirements (may be nested, e.g. Corebit `functional/`, `globals/`, `contracts/`, `templates/`) |

Gate object: `{id, kind (test|static|build|security|manual|integration), command: argv[],
negative: bool, requirements[], evidence: {format: unittest|junit|none, path?:
".looprch/test-evidence/*.xml"}, timeout_seconds?}`.

Real-scale reference (Corebit, `/var/www/html/Corebit`): 89 phases, 403 documents, 1,074
requirement ids, 813 gates (static 356, test 178, build 91, manual 91, integration 89, security
8), manifest 2.25 MB, context views 9.8 MB total, median ~110 KB, largest P-089 920 KB.
Gate argv[0] only `php`, `npm`, `composer`, `npx`. 109 files mode 600. Two fingerprints exist
(source fingerprint in context headers/refinement; package fingerprint in `package-lock.json`).

## 2. Discovery and trust (`/lr-init`)

1. Package root must equal the project root [D-16]: `phases/manifest.json` with
   `schema_version: sev3/1`. Reject other `manifest.json` files (e.g. Corebit `looprch/manifest.json`).
   If found only in a subfolder → clear error explaining v1 needs the package at the root.
2. Unknown `toolkit_version` → reject with "update Looprch".
3. Compare `phases/tools/*` and `tooling-lock.json` with `vendor/sev3-toolkit/1.2.0/SHA256SUMS`.
   Mismatch → stop (a package cannot self-authorize a modified reader).
4. Run vendored `verify_package.py --root <project>`; must be ok.
5. Record package fingerprint (`specctl.py fingerprint`) and phase list summary in `state.json`.
6. Show the distinct gate commands (argv[0] set and count) once; record user acknowledgement with
   the manifest hash (security enhancement).
7. Check file readability (mode 600 under another uid → explicit error).

## 3. Freshness

At every phase preflight recompute the fingerprint. Changed → stop with
`blocked: spec changed` and instructions for controlled reconciliation (SEV3: never retroactively
overwrite closed evidence). No automatic re-import.

## 4. Packets

`python3 <vendor>/phase_context.py --root <project> --phase P-NNN --role <r> --output
.looprch/packets/P-NNN/<r>.md` with roles `planner | plan-debater | implementer | tester |
reviewer` (exact tool choices). The tool refuses outputs outside `.looprch/` or `.sev3-cache/`.
Briefs reference the packet path; the packet is never truncated or summarized. Expansion requests
from a role (`{document|phase, question, reason}` in its result block) are executed with
`--include-document` / `--include-phase` + `--question` + `--reason`, recorded in the journal,
and change no scope.

Context-size guard: compare packet bytes with the assigned agent/model's configured budget
(`agents.<id>.context_kb`, user-editable defaults); over budget → warn and suggest a fallback
with a larger budget; never truncate.

## 5. Gates and evidence

- Runner: `execFile(argv[0], argv.slice(1), {cwd: project, timeout})`, no shell.
- `unittest`: require "Ran N tests" with N > 0 and final `OK` and exit 0.
- `junit`: parse XML; count non-skipped testcases > 0; failures = errors = 0 at testcase level AND
  suite counters (a file with declared failures never passes — 5.x bug F-02).
- `none`: exit 0 only (static/build). `manual`: requires a Reviewer (or Tester) inspection report
  file recorded with the gate; no `true` commands.
- `negative: true` and kinds `test`/`integration` require non-empty machine evidence.
- Record per run in `.looprch/phases/P-NNN/gates.json`: argv, exit, duration, counts, evidence
  sha256, `git write-tree` hash of the tested snapshot. Any later edit invalidates earlier gate
  results (snapshot mismatch).

## 6. todo.md updates

Only Looprch edits `phases/todo.md`, only flipping `[ ]`→`[x]` on exact item lines, only after:
implementation recorded; each gate passed on the final snapshot; independent test verdict pass;
review approve; handover accepted. Phase line last. `PROJECT:production-readiness` only in
`/lr-finish`. Never any other edit.

## 7. Handover (SEV3 EXECUTION_GUIDE + phase handover section)

Implementer final handover must contain: Phase Summary; Key Decisions & Notes; Modified Files;
New Files; deleted/renamed/reverted paths; migrations and rollback/forward recovery; published
contracts and actual paths; exact final verification identities (gate run ids + hashes);
limitations; contributing implementers. Looprch checks file lists against
`git diff --name-status <phase-base>` and rejects mismatches. Stored as
`.looprch/phases/P-NNN/handover.md` (committed, immutable after close). Later Looprch phases get
pointers to CLOSED handovers of related phases (`related`, `requires`, `uses` producers).

SEV3 refers to "Looprch's handover-and-git guide": Looprch must ship `docs/user/handover-and-git.md`.

## 8. Conventions found in a real package (Corebit survey, 2026-10-03)

A project's generated `phases/AGENTS.md` can be more specific than the SEV3 template. Corebit's names:

| Path / setting | Meaning | Looprch handling |
|---|---|---|
| `.looprch/test-evidence/<P-NNN>-*.xml` | JUnit output written by gate commands | Create the directory before running gates; raw files gitignored, hashes recorded in `gates.json` |
| `.looprch/reports/P-NNN-trace.json` | Report written by `manual` trace gates | Create the directory; same treatment as test evidence |
| `.looprch/user-rules.md` | Project rules every role must read | If present, its path goes into every brief |
| `.looprch/briefs/`, `.looprch/results/` | Where Planner and Lead artifacts go | Satisfied by "the installed runtime's allowed paths"; Looprch's own layout is acceptable |
| `.sev3-cache/` | Exploratory packet output | Allowed; gitignore it |
| `COREBIT_SPEC_ROOT` env | Project-specific variable that gate commands need | Generic `config.gates.env` map passed to gate processes; never guessed |

Other facts:
- `phase_context.py --phase` accepts `P-001`, `001` or `1`. Looprch always passes `P-NNN`.
- The live packet differs from the sealed `phases/context/en/P-NNN.md` view. For example, the P-001 planner packet is 106 KB, with 21 `## SOURCE path:start-end` blocks. The context-size guard measures the live packet.
- `verify_package.py` returns `{"ok": true, …, "semantic_translation_verified": false, "application_verified": false}`. Status output must never present this as application verification.
- `specctl.py seal` and `--init-todo` rewrite generated files, so Looprch never runs them. `verify_package.py --help` lists `seal` because it is a `validate` alias, which is misleading.
- Each gate's `requirements[]` repeats the phase's full ID list. Looprch must not treat a gate as proof of each ID it lists.
- `relations.json` uses different keys from the manifest (`execution_prerequisites`, a richer `related`). Looprch reads only `manifest.json` for ordering and prerequisites.
- Context views are English only, while phase and requirement bodies are bilingual with identical markers. Looprch uses English only.
- Corebit's 1,259 `todo.md` boxes are all unchecked. `todo.md` is excluded from `package-lock.json`.

## 9. Closure phase

The `kind: closure` phase runs through `/lr-finish` [D-18] with the normal lifecycle, then
`PROJECT:production-readiness` is ticked and a final report written to `.looprch/FINAL_REPORT.md`.
