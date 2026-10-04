# Git integration

All git calls go through `src/git/git.ts` (`spawnSync("git", args)`, no shell).

## Commands used

| Purpose | Commands |
|---|---|
| repository | `rev-parse --show-toplevel`, `init -q -b main` |
| identity | `var GIT_COMMITTER_IDENT`, `var GIT_AUTHOR_IDENT` |
| status | `status --porcelain=v1 -z --untracked-files=all` |
| commits | `add -A`, `diff --cached --quiet`, `commit -q -m` |
| phase branch | `switch -q -c looprch/P-NNN`, `switch -q <branch>`, `merge-base` |
| close | `switch -q <base>`, `merge --no-ff -q looprch/P-NNN -m ...`, `merge --abort` on conflict, `tag -a looprch/P-NNN`, `branch -q -d` |
| snapshots | temporary `GIT_INDEX_FILE`: `add -A -- .`, `rm -r -q -f --cached --ignore-unmatch -- .looprch phases/todo.md`, `write-tree` |
| diffs | `diff --name-status -M -z <base> <tree>`, `diff --name-only -z`, `diff <base> HEAD` |

Never used: push, force-push, reset, rebase, stash. `test/integration/git.test.ts` scans `src/`
for them.

## Snapshot trees

`snapshotTree(root)` copies the real index to a temporary file, stages the whole working tree
(untracked, non-ignored files included) into it, removes `.looprch/` and `phases/todo.md`, and
writes a tree. The real index is untouched. Gate results, review approval and the handover are
bound to these hashes; `gates run` stores the post-run tree so files created by the gate command
itself do not invalidate it.

## Rules

- Before the first phase: init if needed, identity required, baseline commit offered.
- Clean checks ignore Looprch's mutable files (`config.json`, `state.json`, `events.jsonl`),
  which are swept into the next Looprch commit.
- Between the final close commit and the merge, nothing writes tracked files (state and journal
  are written before the commit and after the merge).
- A Looprch checkpoint committed just before a crash (HEAD's parent is the recorded commit and
  the message starts with `looprch(P-NNN):`) is adopted; any other HEAD change blocks.
- Hooks run; a failing hook blocks with its output.
