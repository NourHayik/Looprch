import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../core/constants.js";
import { writeFileAtomic } from "../core/fsx.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { verifyManifest, verifySums } from "../install/manifest.js";
import { parseRelayResult, SAMPLE_RESULT } from "../delegate/result.js";
import { extractResultBlock } from "../core/results.js";
import { pythonVersion, runTool, vendorDir } from "../sev3/toolkit.js";
import { parse } from "./args.js";
import { out } from "./output.js";

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

function check(id: string, fn: () => string): Check {
  try {
    return { id, ok: true, detail: fn() };
  } catch (err) {
    return { id, ok: false, detail: (err as Error).message };
  }
}

export function selfTest(): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  checks.push(
    check("node", () => {
      const major = Number(process.versions.node.split(".")[0]);
      if (major < 22) throw new Error(`Node ${process.versions.node} < 22`);
      return process.versions.node;
    }),
  );
  checks.push(
    check("manifest", () => {
      const r = verifyManifest(packageRoot());
      if (!r.ok) throw new Error(r.error ?? `mismatched: ${[...r.missing, ...r.mismatched].join(", ")}`);
      return `${r.files} files verified`;
    }),
  );
  checks.push(
    check("toolkit", () => {
      const r = verifySums(vendorDir());
      if (!r.ok) throw new Error(`vendored SEV3 toolkit differs: ${r.mismatched.join(", ")}`);
      return `SEV3 toolkit ${Object.keys(r.expected).length} files match SHA256SUMS`;
    }),
  );
  checks.push(
    check("python", () => {
      const v = pythonVersion();
      if (!v.ok) throw new Error(`python3 3.10+ required (found ${v.version ?? "none"})`);
      const r = runTool("specctl.py", ["--help"], 30_000);
      if (r.code !== 0) throw new Error(`specctl.py --help failed: ${r.stderr.slice(0, 200)}`);
      return v.version!;
    }),
  );
  checks.push(
    check("fs_lock", () => {
      const dir = mkdtempSync(join(tmpdir(), "looprch-selftest-"));
      try {
        writeFileAtomic(join(dir, "x.json"), "{}");
        if (readFileSync(join(dir, "x.json"), "utf8") !== "{}") throw new Error("atomic write mismatch");
        acquireLock(dir, null, "self-test");
        releaseLock(dir);
        return "atomic write and lock ok";
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
  checks.push(
    check("relay_result", () => {
      const r = parseRelayResult(SAMPLE_RESULT);
      const block = extractResultBlock(r.finalMessage);
      if (r.status !== "completed" || !block.ok) throw new Error("sample relay result did not parse");
      return "delegate-relay.result.v1 sample parsed";
    }),
  );
  return { ok: checks.every((c) => c.ok), checks };
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, {}, "looprch self-test [--json]");
  const r = selfTest();
  out(!!values.json, r, () => r.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.id.padEnd(13)} ${c.detail}`).join("\n"));
  return r.ok ? 0 : 1;
}
