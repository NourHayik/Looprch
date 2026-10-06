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

/** Shortest exact duration text for `ms` (whole hours, minutes or seconds, rounded up to a second). */
export function formatDuration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

export function scaleDuration(text: string, factor: number): string {
  return formatDuration(parseDuration(text) * factor);
}

/** Review round n gets 1x, 1.5x, 2x, ... of the base Reviewer timeout. */
export function reviewTimeout(base: string, round: number): string {
  return round <= 1 ? base : scaleDuration(base, 1 + 0.5 * (round - 1));
}

export function isDuration(text: unknown): text is string {
  return typeof text === "string" && /^\d+[hms]$/.test(text);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
