let override: (() => number) | null = null;

export function now(): number {
  return override ? override() : Date.now();
}

export function nowIso(): string {
  return new Date(now()).toISOString();
}

/** Unit tests only. */
export function setClock(fn: (() => number) | null): void {
  override = fn;
}

export function parseDuration(text: string): number {
  const m = /^(\d+)([hms])$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration "${text}" (use e.g. 30m, 2h, 45s)`);
  const n = Number(m[1]);
  const unit = m[2];
  return n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000);
}

export function isDuration(text: unknown): text is string {
  return typeof text === "string" && /^\d+[hms]$/.test(text);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
