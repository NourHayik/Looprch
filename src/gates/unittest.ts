export interface Counts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

export interface ParseResult {
  ok: boolean;
  counts: Counts;
  reason: string | null;
}

/** Python unittest: "Ran N tests" with N > 0, a final "OK" line, exit 0, and not everything skipped. */
export function parseUnittest(output: string, exitCode: number | null): ParseResult {
  const counts: Counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const ran = [...output.matchAll(/^Ran (\d+) tests? in /gm)].at(-1);
  if (!ran) return { ok: false, counts, reason: 'no "Ran N tests" line in the output' };
  counts.tests = Number(ran[1]);
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  const failed = /^FAILED \((.*)\)$/.exec(last);
  const okLine = /^OK( \((.*)\))?$/.exec(last);
  const detail = failed?.[1] ?? okLine?.[2] ?? "";
  for (const part of detail.split(",").map((p) => p.trim())) {
    const m = /^(failures|errors|skipped)=(\d+)$/.exec(part);
    if (m) counts[m[1] as "failures" | "errors" | "skipped"] = Number(m[2]);
  }
  if (counts.tests === 0) return { ok: false, counts, reason: "Ran 0 tests (an empty suite is not evidence)" };
  if (!okLine) return { ok: false, counts, reason: failed ? `unittest reported FAILED (${failed[1]})` : `last line is not OK: ${last.slice(0, 120)}` };
  if (exitCode !== 0) return { ok: false, counts, reason: `exit code ${exitCode} despite OK` };
  if (counts.skipped >= counts.tests) return { ok: false, counts, reason: "every test was skipped" };
  return { ok: true, counts, reason: null };
}
