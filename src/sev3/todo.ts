import { readFileSync, statSync } from "node:fs";
import { LrError } from "../core/errors.js";
import { writeFileAtomic } from "../core/fsx.js";
import { projectPaths } from "../core/paths.js";

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const TODO_KEY = /^(P-\d{3,}(:implementation|:gate:.+|:independent-test|:independent-review|:handover)?|PROJECT:production-readiness)$/;

/** Flip exactly one `[ ]` to `[x]` on the line whose key matches. No other edit, ever. */
export function tickText(text: string, key: string): { text: string; changed: boolean } {
  if (!TODO_KEY.test(key)) throw new LrError("todo_key_invalid", `Invalid todo key ${key}`);
  const isPhaseLine = /^P-\d+$/.test(key);
  const tail = isPhaseLine ? " - .*" : "";
  const open = new RegExp(`^(\\s*- )\\[ \\]( ${escape(key)}${tail})$`, "m");
  const done = new RegExp(`^\\s*- \\[x\\] ${escape(key)}${tail}$`, "m");
  if (open.test(text)) return { text: text.replace(open, "$1[x]$2"), changed: true };
  if (done.test(text)) return { text, changed: false };
  throw new LrError("todo_line_missing", `phases/todo.md has no line for ${key}`);
}

export function tick(root: string, key: string): { changed: boolean } {
  const path = projectPaths(root).todo;
  const before = readFileSync(path, "utf8");
  const { text, changed } = tickText(before, key);
  if (changed) writeFileAtomic(path, text, statSync(path).mode & 0o777);
  return { changed };
}

export function isTicked(root: string, key: string): boolean {
  const text = readFileSync(projectPaths(root).todo, "utf8");
  const tail = /^P-\d+$/.test(key) ? " - .*" : "";
  return new RegExp(`^\\s*- \\[x\\] ${escape(key)}${tail}$`, "m").test(text);
}
