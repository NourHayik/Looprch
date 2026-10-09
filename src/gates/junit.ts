import type { Counts, ParseResult } from "./unittest.js";

function attr(tag: string, name: string): number {
  const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(tag);
  return m ? Number(m[1]) || 0 : 0;
}

/**
 * JUnit XML without dependencies. Passes only when non-skipped testcases > 0, no testcase has a
 * <failure> or <error>, AND every suite counter for failures/errors is 0 (a file that declares
 * failures never passes, even with clean testcases).
 */
export function parseJunit(xml: string): ParseResult {
  const counts: Counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const body = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  if (!/<testsuites?[\s>]/.test(body)) return { ok: false, counts, reason: "not a JUnit report (no <testsuite>)" };
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let nonSkipped = 0;
  for (const m of body.matchAll(caseRe)) {
    counts.tests++;
    const inner = m[3] ?? "";
    const failed = /<failure\b/.test(inner);
    const errored = /<error\b/.test(inner);
    const skipped = /<skipped\b/.test(inner);
    if (failed) counts.failures++;
    if (errored) counts.errors++;
    if (skipped) counts.skipped++;
    if (!skipped) nonSkipped++;
  }
  let declaredFailures = 0;
  let declaredErrors = 0;
  for (const m of body.matchAll(/<testsuites?\b[^>]*>/g)) {
    declaredFailures += attr(m[0], "failures");
    declaredErrors += attr(m[0], "errors");
  }
  if (nonSkipped === 0) return { ok: false, counts, reason: counts.tests ? "every testcase was skipped" : "no testcases" };
  if (counts.failures || counts.errors) return { ok: false, counts, reason: `${counts.failures} failing and ${counts.errors} erroring testcases` };
  if (declaredFailures || declaredErrors) {
    counts.failures = Math.max(counts.failures, declaredFailures);
    counts.errors = Math.max(counts.errors, declaredErrors);
    return { ok: false, counts, reason: `suite counters declare failures=${declaredFailures} errors=${declaredErrors}` };
  }
  return { ok: true, counts, reason: null };
}
