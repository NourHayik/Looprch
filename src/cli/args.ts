import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { UsageError } from "../core/errors.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

export function parse<O extends Options>(argv: string[], options: O, usage: string) {
  try {
    return parseArgs({ args: argv, options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" }, ...options }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message, usage);
  }
}

/** Project root: --root flag, else the git top-level of cwd, else cwd. */
export function projectRoot(flag?: string): string {
  if (flag) return resolve(flag);
  const cwd = process.cwd();
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (top && existsSync(top)) return top;
  } catch {
    // not a git repository
  }
  return cwd;
}
