import { git } from "../git/git.js";

/** Paths of test code in the common layouts (PHPUnit/Pest, Jest/Vitest, pytest/unittest, Go, RSpec). */
const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go|rb)$|(^|\/)test_[^/]*\.py$|Test\.php$/i;

/** Markers that skip, focus or stub out tests. A focused test silently skips every other test. */
const MARKERS: [RegExp, string][] = [
  [/\b(?:it|test|describe|suite|context)\.(?:only|skip|todo)\s*\(/, "focus/skip (.only/.skip/.todo)"],
  [/\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/, "focus/skip (xit/fit)"],
  [/->\s*(?:skip|todo|markTestSkipped|markTestIncomplete)\s*\(|\$this->markTest(?:Skipped|Incomplete)\s*\(/, "PHPUnit/Pest skip"],
  [/#\[\s*(?:Skip|Ignore)\b|@group\s+skip\b/, "PHP skip attribute"],
  [/@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.skip\w*)\b|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(/, "pytest/unittest skip"],
  [/\bt\.Skip(?:f|Now)?\s*\(/, "Go t.Skip"],
];

/** A line may keep a skip when it says why: `looprch-allow-skip: <reason>`. */
const ALLOW = /looprch-allow-skip:\s*\S/;

export interface IntegrityProblem {
  file: string;
  marker: string;
  line: string;
}

/**
 * Skip and focus markers the phase added to test files (`git diff -U0 base tree`). They make a
 * green gate prove less than it claims, which is how an AI tester most cheaply "passes"; Looprch
 * sends them back to the Tester before any evidence is bound.
 */
export function testIntegrityProblems(root: string, base: string, tree: string): IntegrityProblem[] {
  const r = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", base, tree]);
  if (r.code !== 0) return [];
  const out: IntegrityProblem[] = [];
  let file: string | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (!file || !line.startsWith("+") || line.startsWith("+++") || !TEST_PATH.test(file) || ALLOW.test(line)) continue;
    for (const [re, marker] of MARKERS)
      if (re.test(line)) {
        out.push({ file, marker, line: line.slice(1).trim().slice(0, 160) });
        break;
      }
  }
  return out;
}
