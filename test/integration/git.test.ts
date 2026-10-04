import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { GIT_IDENTITY, REPO, git, initRepo, tmp } from "../helpers/tmp.js";
import { initGit, baselineStatus } from "../../src/git/baseline.js";
import { checkpoint, closePhase, startPhaseBranch } from "../../src/git/phase.js";
import { diffNameStatus, snapshotTree } from "../../src/git/snapshot.js";
import { commitAll, currentBranch, head } from "../../src/git/git.js";
import { LrError } from "../../src/core/errors.js";

function withIdentity<T>(fn: () => T): T {
  const saved = { ...process.env };
  Object.assign(process.env, GIT_IDENTITY);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(GIT_IDENTITY)) if (saved[k] === undefined) delete process.env[k];
  }
}

function repo(): string {
  const d = tmp();
  initRepo(d);
  writeFileSync(join(d, "a.txt"), "a\n");
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "init"]);
  return d;
}

describe("git integration", () => {
  test("init on a non-repo creates main", () => {
    const d = tmp();
    const r = initGit(d, false);
    assert.equal(r.initialized, true);
    assert.equal(r.base_branch, "main");
  });

  test("missing identity blocks the baseline", () => {
    const d = tmp();
    initRepo(d);
    writeFileSync(join(d, "x"), "1");
    const env = { ...process.env };
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(GIT_IDENTITY)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GIT_CONFIG_GLOBAL = join(d, "nonexistent-gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      assert.throws(() => initGit(d, true), (e: unknown) => e instanceof LrError && e.code === "no_git_identity");
    } finally {
      process.env = env;
    }
  });

  test("baseline lists secret-like files and commits", () => {
    withIdentity(() => {
      const d = tmp();
      initRepo(d);
      writeFileSync(join(d, ".env"), "SECRET=1");
      writeFileSync(join(d, "app.py"), "x=1");
      assert.deepEqual(baselineStatus(d).secret_like, [".env"]);
      const r = initGit(d, true);
      assert.ok(r.baseline_commit);
      assert.equal(git(d, ["log", "-1", "--format=%s"]), "looprch: baseline");
    });
  });

  test("branch, checkpoints and close give a no-ff merge with two parents and a tag", () => {
    withIdentity(() => {
      const d = repo();
      const base = startPhaseBranch(d, "P-001", "main");
      assert.equal(currentBranch(d), "looprch/P-001");
      writeFileSync(join(d, "b.txt"), "b\n");
      assert.ok(checkpoint(d, "P-001", "implementation"));
      assert.equal(checkpoint(d, "P-001", "noop"), null);
      writeFileSync(join(d, "c.txt"), "c\n");
      const r = closePhase(d, "P-001", "Title", "main", true);
      assert.equal(currentBranch(d), "main");
      assert.equal(git(d, ["log", "-1", "--format=%P", r.merge_commit]).split(" ").length, 2);
      assert.equal(git(d, ["rev-list", "-n1", "looprch/P-001"]), r.merge_commit);
      assert.equal(git(d, ["branch", "--list", "looprch/P-001"]), "");
      assert.notEqual(base, r.merge_commit);
    });
  });

  test("a merge conflict aborts and leaves the phase branch intact", () => {
    withIdentity(() => {
      const d = repo();
      startPhaseBranch(d, "P-002", "main");
      writeFileSync(join(d, "a.txt"), "phase\n");
      checkpoint(d, "P-002", "implementation");
      git(d, ["switch", "-q", "main"]);
      writeFileSync(join(d, "a.txt"), "user\n");
      git(d, ["commit", "-qam", "user edit"]);
      git(d, ["switch", "-q", "looprch/P-002"]);
      assert.throws(() => closePhase(d, "P-002", "T", "main", true), (e: unknown) => e instanceof LrError && e.code === "merge_conflict");
      assert.equal(currentBranch(d), "looprch/P-002");
      assert.equal(readFileSync(join(d, "a.txt"), "utf8"), "phase\n");
      assert.equal(git(d, ["status", "--porcelain"]), "");
    });
  });

  test("snapshot changes with an untracked file and ignores .looprch and todo", () => {
    withIdentity(() => {
      const d = repo();
      const t1 = snapshotTree(d);
      mkdirSync(join(d, ".looprch"), { recursive: true });
      writeFileSync(join(d, ".looprch/state.json"), "{}");
      mkdirSync(join(d, "phases"), { recursive: true });
      writeFileSync(join(d, "phases/todo.md"), "- [x] x");
      assert.equal(snapshotTree(d), t1);
      writeFileSync(join(d, "new.py"), "x");
      const t2 = snapshotTree(d);
      assert.notEqual(t2, t1);
      assert.equal(git(d, ["status", "--porcelain", "--", "new.py"]), "?? new.py");
      const ns = diffNameStatus(d, head(d)!, t2);
      assert.deepEqual(ns.added, ["new.py"]);
    });
  });

  test("name-status reports renames and deletions", () => {
    withIdentity(() => {
      const d = repo();
      writeFileSync(join(d, "long.txt"), "line\n".repeat(50));
      commitAll(d, "add long");
      const base = head(d)!;
      git(d, ["mv", "long.txt", "renamed.txt"]);
      git(d, ["rm", "-q", "a.txt"]);
      const ns = diffNameStatus(d, base, snapshotTree(d));
      assert.deepEqual(ns.renamed, [{ from: "long.txt", to: "renamed.txt" }]);
      assert.deepEqual(ns.deleted, ["a.txt"]);
    });
  });

  test("a failing pre-commit hook blocks with its output", () => {
    withIdentity(() => {
      const d = repo();
      const hook = join(d, ".git/hooks/pre-commit");
      writeFileSync(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      writeFileSync(join(d, "z.txt"), "z");
      assert.throws(() => commitAll(d, "x"), (e: unknown) => e instanceof LrError && e.code === "hook_failed" && /lint failed/.test(e.message));
      assert.ok(statSync(hook).isFile());
    });
  });

  test("phase_branches false: close commits and tags on the base branch", () => {
    withIdentity(() => {
      const d = repo();
      writeFileSync(join(d, "q.txt"), "q");
      const r = closePhase(d, "P-001", "T", "main", false);
      assert.equal(currentBranch(d), "main");
      assert.equal(git(d, ["rev-list", "-n1", "looprch/P-001"]), r.merge_commit);
    });
  });
});

describe("forbidden git operations", () => {
  test("src never calls push, reset, rebase or stash", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(join(REPO, "src"));
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      assert.doesNotMatch(text, /["'](push|reset|rebase|stash)["']/, f);
      assert.doesNotMatch(text, /["']--force["']/, f);
    }
  });
});
