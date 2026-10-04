# Handover and git

This is the "handover-and-git guide" that SEV3's `EXECUTION_GUIDE.md` refers to.

## Before the first phase

1. No repository → `git init -b main`. No remote is required or added.
2. No `user.name` / `user.email` → Looprch stops and tells you how to set them. It never invents
   an identity.
3. No commits yet, or uncommitted files → Looprch lists the files, warns about secret-like names
   (`.env*`, `*.pem`, `id_*`, `*.key`) and asks once to commit them as `looprch: baseline`. If you
   decline, the phase does not start.
4. Looprch records the base branch (your current branch) and the baseline commit.

## During a phase

- Work happens on `looprch/P-NNN`, created from the base branch.
- Looprch commits stage checkpoints: `looprch(P-NNN): plan approved`, `implementation`,
  `repair N`, `agent switch (...)`. Agents never commit.
- Gate results in `.looprch/phases/P-NNN/gates.json` are bound to a hash of your working tree
  (`git write-tree` of a temporary index, without `.looprch/` and `phases/todo.md`). Any later
  change invalidates them and the gates run again before review or handover is accepted.
- If you switch branches or commit yourself, `looprch next` blocks with `head_mismatch`.

## The final handover

The Implementer writes the handover with these headings: Phase Summary; Key Decisions & Notes;
Modified Files; New Files; deleted, renamed or reverted paths; migrations and rollback/forward
recovery; published contracts and actual paths; final verification identities (gate run ids);
limitations. Looprch then:

- compares Modified, New, Deleted and Renamed with `git diff --name-status <phase base>` of the
  final snapshot (untracked files included); a mismatch is sent back once, then blocks;
- rejects a handover run that changed files (the gates and review run again);
- appends the contributing implementers (every agent and model that wrote code in the phase) and
  the gate run identities;
- stores it as `.looprch/phases/P-NNN/handover.md`, committed and never rewritten.

Later phases receive pointers to the CLOSED handovers of related phases.

## Closing

1. Tick `phases/todo.md` (implementation, each gate, independent test, independent review,
   handover, then the phase line). Only Looprch edits this file.
2. Final commit `looprch(P-NNN): close` with code, `.looprch/phases/P-NNN/*`, state and journal.
3. `git switch <base>` and `git merge --no-ff looprch/P-NNN`.
4. Tag `looprch/P-NNN` on the merge commit and delete the phase branch.

## Failure and recovery

| Situation | What Looprch does | What you do |
|---|---|---|
| Merge conflict | `git merge --abort`, back to the phase branch, `blocked: merge_conflict` | resolve on the base branch (`git merge --no-ff looprch/P-NNN`), switch back, `looprch resume` |
| A hook rejects a commit | `blocked: hook_failed` with the hook output | fix it, `looprch resume` |
| Uncommitted changes before a phase | `blocked: dirty_tree` with the file list | commit or remove them, `looprch resume` |
| Extra commits during a phase | `blocked: head_mismatch` | undo them yourself, `looprch resume` |
| Interrupted mid-phase | checkpoints keep partial work | `/lr-resume` |

Looprch never pushes, force-pushes, resets, rebases or stashes. Hooks are respected.

To review a closed phase later: `git diff looprch/P-NNN^1 looprch/P-NNN`, or `/lr-review P-NNN`.
