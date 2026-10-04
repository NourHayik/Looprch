import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { gitOk } from "./git.js";

export const SNAPSHOT_EXCLUDES = [".looprch", "phases/todo.md"];

function excluded(path: string): boolean {
  return path === "phases/todo.md" || path === ".looprch" || path.startsWith(".looprch/");
}

/**
 * Tree hash of the working tree (tracked + untracked, not ignored), without `.looprch/` and
 * `phases/todo.md`. Uses a temporary index; the real index is never touched.
 */
export function snapshotTree(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "looprch-idx-"));
  const tmpIndex = join(dir, "index");
  try {
    let real = gitOk(root, ["rev-parse", "--git-path", "index"]);
    if (!isAbsolute(real)) real = join(root, real);
    if (existsSync(real)) copyFileSync(real, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    gitOk(root, ["add", "-A", "--", "."], env);
    gitOk(root, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ...SNAPSHOT_EXCLUDES], env);
    return gitOk(root, ["write-tree"], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface NameStatus {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
}

/** `git diff --name-status -M <base> <tree>`, without Looprch's own files. */
export function diffNameStatus(root: string, base: string, tree: string): NameStatus {
  const out = gitOk(root, ["diff", "--name-status", "-M", "-z", base, tree]);
  const parts = out.split("\0").filter((p) => p.length > 0);
  const res: NameStatus = { added: [], modified: [], deleted: [], renamed: [] };
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!;
    const code = status[0];
    if (code === "R" || code === "C") {
      const from = parts[++i]!;
      const to = parts[++i]!;
      if (excluded(from) && excluded(to)) continue;
      if (code === "R") res.renamed.push({ from, to });
      else res.added.push(to);
      continue;
    }
    const path = parts[++i]!;
    if (excluded(path)) continue;
    if (code === "A") res.added.push(path);
    else if (code === "D") res.deleted.push(path);
    else res.modified.push(path);
  }
  return res;
}

export function changedBetween(root: string, a: string, b: string): string[] {
  if (a === b) return [];
  return gitOk(root, ["diff", "--name-only", "-z", a, b])
    .split("\0")
    .filter((p) => p && !excluded(p));
}
