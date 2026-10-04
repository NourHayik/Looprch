import { spawnSync } from "node:child_process";
import { LrError } from "../core/errors.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** git through execFile semantics (no shell). */
export function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}): GitResult {
  const r = spawnSync("git", args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === "ENOENT") throw new LrError("git_missing", "git is not on PATH", "Install git");
    throw r.error;
  }
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function gitOk(root: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const r = git(root, args, env);
  if (r.code !== 0) throw new LrError("git_failed", `git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export function isRepo(root: string): boolean {
  const r = git(root, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export function hasCommits(root: string): boolean {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).code === 0;
}

export function head(root: string): string | null {
  const r = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function currentBranch(root: string): string | null {
  const r = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function hasIdentity(root: string): boolean {
  return git(root, ["var", "GIT_COMMITTER_IDENT"]).code === 0 && git(root, ["var", "GIT_AUTHOR_IDENT"]).code === 0;
}

export function branchExists(root: string, branch: string): boolean {
  return git(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).code === 0;
}

export function tagExists(root: string, tag: string): boolean {
  return git(root, ["rev-parse", "--verify", "-q", `refs/tags/${tag}`]).code === 0;
}

/** Changed or untracked paths (porcelain v1, -z). */
export function statusPaths(root: string): string[] {
  const r = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (r.code !== 0) throw new LrError("git_failed", `git status failed: ${r.stderr.trim()}`);
  const parts = r.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return paths;
}

/** Looprch-owned mutable files that are swept into the next Looprch commit. */
export const MUTABLE_OWNED = [".looprch/config.json", ".looprch/state.json", ".looprch/events.jsonl"];

export function dirtyFiles(root: string, ignoreOwned = true): string[] {
  return statusPaths(root).filter((p) => !(ignoreOwned && MUTABLE_OWNED.includes(p)));
}

const SECRET_LIKE = [/(^|\/)\.env(\..*)?$/, /\.pem$/, /(^|\/)id_[^/]*$/, /\.key$/];

export function secretLike(paths: string[]): string[] {
  return paths.filter((p) => SECRET_LIKE.some((re) => re.test(p)));
}

/** `git add -A` then commit; returns null when there is nothing to commit. Hooks run. */
export function commitAll(root: string, message: string): string | null {
  gitOk(root, ["add", "-A"]);
  if (git(root, ["diff", "--cached", "--quiet"]).code === 0) return null;
  const r = git(root, ["commit", "-q", "-m", message]);
  if (r.code !== 0) {
    const output = (r.stderr + r.stdout).trim();
    if (!hasIdentity(root)) throw new LrError("no_git_identity", "git has no user.name/user.email", 'Set one: git config user.name "Your Name" && git config user.email you@example.com');
    throw new LrError("hook_failed", `git commit failed (a hook may have rejected it): ${output}`, "Fix the hook failure, then run looprch resume", 1, output);
  }
  return head(root);
}
