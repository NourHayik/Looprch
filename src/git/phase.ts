import { LrError } from "../core/errors.js";
import { branchExists, commitAll, currentBranch, git, gitOk, head, tagExists } from "./git.js";

export function phaseBranch(phase: string): string {
  return `looprch/${phase}`;
}

export function phaseTag(phase: string): string {
  return `looprch/${phase}`;
}

/** Create (or re-enter after a crash) looprch/P-NNN from the base branch; returns the phase base commit. */
export function startPhaseBranch(root: string, phase: string, base: string): string {
  const branch = phaseBranch(phase);
  const baseCommit = head(root);
  if (!baseCommit) throw new LrError("no_commits", "The repository has no commits");
  if (branchExists(root, branch)) {
    if (currentBranch(root) !== branch) gitOk(root, ["switch", "-q", branch]);
    return gitOk(root, ["merge-base", base, branch]);
  }
  gitOk(root, ["switch", "-q", "-c", branch]);
  return baseCommit;
}

export function checkpoint(root: string, phase: string, label: string): string | null {
  return commitAll(root, `looprch(${phase}): ${label}`);
}

export interface CloseResult {
  close_commit: string | null;
  merge_commit: string;
  tag: string;
}

/**
 * Final commit on the phase branch, then `merge --no-ff` into base, tag, delete the branch.
 * Nothing may write tracked files between the final commit and the merge.
 */
export function closePhase(root: string, phase: string, title: string, base: string, useBranches: boolean): CloseResult {
  const close = commitAll(root, `looprch(${phase}): close`);
  const tag = phaseTag(phase);
  let mergeCommit: string;
  if (useBranches) {
    const branch = phaseBranch(phase);
    gitOk(root, ["switch", "-q", base]);
    const m = git(root, ["merge", "--no-ff", "-q", branch, "-m", `looprch: close ${phase} ${title}`]);
    if (m.code !== 0) {
      const conflicted = git(root, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
      git(root, ["merge", "--abort"]);
      gitOk(root, ["switch", "-q", branch]);
      throw new LrError(
        "merge_conflict",
        `Merging ${branch} into ${base} conflicts${conflicted.length ? ` in: ${conflicted.join(", ")}` : `: ${(m.stderr || m.stdout).trim()}`}`,
        `Resolve it yourself: git switch ${base} && git merge --no-ff ${branch}, fix conflicts and commit; then git switch ${branch} and run looprch resume. Or undo the change on ${base}.`,
        1,
        { conflicted },
      );
    }
    mergeCommit = head(root)!;
  } else {
    mergeCommit = head(root)!;
  }
  if (!tagExists(root, tag)) gitOk(root, ["tag", "-a", tag, "-m", `Looprch ${phase} ${title}`, mergeCommit]);
  if (useBranches) gitOk(root, ["branch", "-q", "-d", phaseBranch(phase)]);
  return { close_commit: close, merge_commit: mergeCommit, tag };
}
