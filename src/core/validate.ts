export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export class Issues {
  errors: string[] = [];
  warnings: string[] = [];
  error(msg: string): void {
    this.errors.push(msg);
  }
  warn(msg: string): void {
    this.warnings.push(msg);
  }
  get ok(): boolean {
    return this.errors.length === 0;
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function isInt(v: unknown, min = -Infinity, max = Infinity): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function oneOf<T extends string>(v: unknown, values: readonly T[]): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}
