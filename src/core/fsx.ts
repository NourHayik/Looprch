import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LrError } from "./errors.js";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some filesystems do not allow fsync on directories; the rename is still atomic.
  }
}

/** Temp file in the same directory, fsync, rename over the target, fsync the directory. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o644): void {
  const dir = dirname(path);
  ensureDir(dir);
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, "w", mode);
  try {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  fsyncDir(dir);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string, validate?: (v: unknown) => T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new LrError("read_failed", `Cannot read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LrError("invalid_json", `Invalid JSON in ${path}: ${(err as Error).message}`);
  }
  return validate ? validate(parsed) : (parsed as T);
}

export function readJsonIfExists<T>(path: string): T | null {
  return existsSync(path) ? readJson<T>(path) : null;
}

export function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
