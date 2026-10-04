# Execution guide

## Read
Use `python phases/tools/phase_context.py --root . --phase NNN --role planner`
from this package root, or pass the package's absolute root. Looprch imports using
its trusted identical toolkit and creates project `.looprch/packets/` automatically.
Do not read every phase or both languages. Read all content in the supplied packet;
indexes and summaries cannot replace normative bodies. Keep source metadata with it.

## Execute
Looprch sequence: Planner -> one Plan Debater -> same Planner synthesis when needed
-> one Implementer -> independent Tester -> independent Reviewer -> final Implementer handover -> verified close.
Implementer writes application code, not tests. Tester owns tests and every declared
gate. Reviewer checks actual code/evidence. Lead orchestrates and never substitutes.
Repairs go to the correct owner/session and return through required verification.

## Finish
All declared gates must pass, test/negative groups must be nonempty, evidence must
match the reviewed snapshot, and prerequisite phases must be closed. Only then may
Looprch persist the handover and update `todo.md`. Final phase checks the complete
production Definition of Done. Generated spec validity does not mean application
correctness. No test-lowmem, OOM/peak gate or fabricated command/test result.

## Change
Do not edit generated indexes/context/locks. Correct approved original sources,
review affected and new boundaries, refresh semantic attestation and reseal with
the fixed tools. A running Looprch detects changed sources and stops for controlled
impact reconciliation; it never retroactively overwrites closed evidence.

## Final semantic handover and Git evidence
After all test/fix and review/fix cycles, the Implementer must supply a final handover
for each task before closure. Require Phase Summary, Key Decisions & Notes, Modified
Files and New Files, plus deleted/renamed/reverted paths and exact final verification
identities. Looprch checks the file lists against the phase baseline and Git evidence.
Later edits invalidate handover approval. A phase closes only after this handover and
a scoped local checkpoint commit; user history, staging and pre-existing dirty files
remain protected. Read Looprch's handover-and-git guide for failure/recovery boundaries.
