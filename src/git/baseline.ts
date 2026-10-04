import { LrError } from "../core/errors.js";
import { commitAll, currentBranch, dirtyFiles, gitOk, hasCommits, hasIdentity, head, isRepo, secretLike } from "./git.js";

export interface BaselineStatus {
  repo: boolean;
  has_commits: boolean;
  branch: string | null;
  dirty: string[];
  secret_like: string[];
  identity: boolean;
}

export function baselineStatus(root: string): BaselineStatus {
  const repo = isRepo(root);
  if (!repo) return { repo, has_commits: false, branch: null, dirty: [], secret_like: [], identity: false };
  const dirty = dirtyFiles(root, false);
  return { repo, has_commits: hasCommits(root), branch: currentBranch(root), dirty, secret_like: secretLike(dirty), identity: hasIdentity(root) };
}

export function ensureRepo(root: string): boolean {
  if (isRepo(root)) return false;
  gitOk(root, ["init", "-q", "-b", "main"]);
  return true;
}

export function requireIdentity(root: string): void {
  if (!hasIdentity(root))
    throw new LrError("no_git_identity", "git has no user.name/user.email configured; Looprch never invents an identity", 'Run: git config --global user.name "Your Name" && git config --global user.email you@example.com');
}

export function commitBaseline(root: string): string {
  requireIdentity(root);
  const sha = commitAll(root, "looprch: baseline");
  return sha ?? head(root)!;
}

export interface InitGitResult {
  initialized: boolean;
  base_branch: string | null;
  baseline_commit: string | null;
  dirty: string[];
  secret_like: string[];
}

export function initGit(root: string, baseline: boolean): InitGitResult {
  const initialized = ensureRepo(root);
  const st = baselineStatus(root);
  let commit: string | null = null;
  if (baseline && (!st.has_commits || st.dirty.length)) commit = commitBaseline(root);
  const after = baselineStatus(root);
  return { initialized, base_branch: after.branch, baseline_commit: commit, dirty: after.dirty, secret_like: after.secret_like };
}
