import { LrError } from "../core/errors.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function out(json: boolean, data: unknown, human: string | (() => string)): void {
  if (json) printJson(data);
  else process.stdout.write(`${typeof human === "function" ? human() : human}\n`);
}

export function printError(err: unknown, json: boolean): number {
  if (err instanceof LrError) {
    if (json) printJson({ ok: false, error: { code: err.code, message: err.message, hint: err.hint ?? null, details: err.details ?? null } });
    else {
      process.stderr.write(`looprch: ${err.message}\n`);
      if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
    }
    return err.exitCode;
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (json) printJson({ ok: false, error: { code: "internal", message: String(err instanceof Error ? err.message : err), hint: null, details: null } });
  else process.stderr.write(`looprch: internal error: ${message}\n`);
  return 1;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}
