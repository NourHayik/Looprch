import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { packageRoot, TOOLKIT_VERSION } from "../core/constants.js";
import { LrError } from "../core/errors.js";

export const TOOL_FILES = ["sev3lib.py", "phase_context.py", "verify_package.py", "specctl.py", "VERSION"] as const;

export function vendorDir(version = TOOLKIT_VERSION): string {
  return join(packageRoot(), "vendor", "sev3-toolkit", version);
}

export interface ToolRun {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
  errorJson: Record<string, unknown> | null;
  ms: number;
}

function tryJson(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    const last = t.split("\n").pop() ?? "";
    try {
      return JSON.parse(last) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** Always the vendored copy, never the package's own tools; no bytecode written. */
export function runTool(name: "specctl.py" | "verify_package.py" | "phase_context.py", args: string[], timeoutMs = 300_000): ToolRun {
  const started = Date.now();
  const res = spawnSync("python3", ["-B", join(vendorDir(), name), ...args], {
    cwd: vendorDir(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new LrError("python_missing", "python3 is not on PATH", "Install Python 3.10 or newer");
    throw new LrError("toolkit_failed", `SEV3 toolkit ${name} failed to start: ${res.error.message}`);
  }
  return {
    code: res.status ?? 1,
    stdout: res.stdout,
    stderr: res.stderr,
    json: tryJson(res.stdout),
    errorJson: tryJson(res.stderr),
    ms: Date.now() - started,
  };
}

export function pythonVersion(): { ok: boolean; version: string | null } {
  const res = spawnSync("python3", ["-c", "import sys;print('%d.%d.%d'%sys.version_info[:3])"], { encoding: "utf8" });
  if (res.status !== 0) return { ok: false, version: null };
  const v = res.stdout.trim();
  const [maj, min] = v.split(".").map(Number);
  return { ok: (maj ?? 0) > 3 || ((maj ?? 0) === 3 && (min ?? 0) >= 10), version: v };
}
