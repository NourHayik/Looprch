# 07 — Git strategy [D-11]

## Before the first phase

1. No repository → `git init -b main`. No remote is required or added.
2. No `user.name`/`user.email` → stop with instructions (never invent an identity).
3. Ensure the Looprch `.gitignore` block exists.
4. No commits yet, or dirty tree → show the file list, warn on secret-like files (`.env*`,
   `*.pem`, `id_*`, `*.key`), offer one commit `looprch: baseline`. User declines → stop.
5. Record `git.base_branch` (current branch) and `git.baseline_commit` in `state.json`.

Why: a clean baseline makes phase diffs and handover file lists exact, and replaces 5.x's
fragile "protect pre-existing dirty files" logic.

## Each phase

1. Preflight: on base branch, clean tree.
2. `git switch -c looprch/P-NNN` from base; record `phase_base` commit.
3. Stage checkpoint commits on the phase branch (Looprch only): plan approved, implementation
   done, each repair round, agent switch (quota fallback). Message format
   `looprch(P-NNN): <stage>`.
4. Close: final commit with code, `.looprch/phases/P-NNN/*`, `state.json`, `events.jsonl`,
   ticked `phases/todo.md`.
5. `git switch <base>` and `git merge --no-ff looprch/P-NNN -m "looprch: close P-NNN <title>"`.
   Conflict → abort the merge, stay on the phase branch, `blocked: merge conflict`, user resolves.
6. Tag `looprch/P-NNN` on the merge commit; delete the phase branch.

## Rules

- Agents never commit (brief instruction; relays never commit by design).
- Looprch never pushes, force-pushes, resets, rebases or stashes.
- Hooks are respected; a failing hook blocks with its output.
- If the user switches branch or edits during a phase, preflight/next detects HEAD mismatch and
  blocks with an explanation.
- `/lr-review` on a closed phase reads `git diff <tag>^1 <tag>`.
