import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const CLI = join(REPO, "dist", "looprch.mjs");
export const FIXTURES = join(REPO, "test", "fixtures");

export const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Looprch Test",
  GIT_AUTHOR_EMAIL: "test@looprch.invalid",
  GIT_COMMITTER_NAME: "Looprch Test",
  GIT_COMMITTER_EMAIL: "test@looprch.invalid",
};

export function tmp(prefix = "lr-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Sandbox {
  dir: string;
  home: string;
  lrHome: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** Isolated HOME, LOOPRCH_HOME and a bin dir prepended to PATH, plus a git identity. */
export function sandbox(extraEnv: NodeJS.ProcessEnv = {}): Sandbox {
  const dir = tmp();
  const home = join(dir, "home");
  const lrHome = join(home, ".looprch");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    LOOPRCH_HOME: lrHome,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    CURSOR_AGENT: "",
    CURSOR_CONVERSATION_ID: "",
    CODEX_THREAD_ID: "",
    CODEX_SANDBOX: "",
    OPENCODE: "",
    ...GIT_IDENTITY,
    ...extraEnv,
  };
  writeFileSync(join(home, ".gitconfig"), "[init]\n\tdefaultBranch = main\n");
  return { dir, home, lrHome, bin, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

export function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; cli?: string } = {}): CliResult {
  const res = spawnSync(process.execPath, [opts.cli ?? CLI, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
    input: opts.input,
    encoding: "utf8",
    timeout: 120_000,
  });
  let json: any = null;
  if (args.includes("--json")) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
  }
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, json };
}

export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_IDENTITY, ...env }, encoding: "utf8" }).trim();
}

export function initRepo(dir: string, env: NodeJS.ProcessEnv = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"], env);
}

export function copyFixture(name: string, dest: string): void {
  cpSync(join(FIXTURES, name), dest, { recursive: true, filter: (src) => !src.includes("__pycache__") });
}

export function writeExecutable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}
