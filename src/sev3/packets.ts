import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { LrError } from "../core/errors.js";
import { projectPaths } from "../core/paths.js";
import { runTool } from "./toolkit.js";

/** Config role keys mapped to the toolkit's packet roles. Worker has no packet (OI-10). */
export const PACKET_ROLE: Record<string, string | null> = {
  planner: "planner",
  plan_debater: "plan-debater",
  implementer: "implementer",
  tester: "tester",
  reviewer: "reviewer",
  worker: null,
};

export interface Packet {
  path: string;
  bytes: number;
  sources: number;
}

export interface ExpansionOpts {
  documents?: string[];
  phases?: string[];
  question?: string;
  reason?: string;
}

function classifyError(message: string): LrError {
  if (/Package changed since seal|Refinement is stale|Tooling drift|Registry drift|Relationship graph drift|Invalid package fingerprint/i.test(message))
    return new LrError("spec_changed", `The SEV3 package changed since it was sealed: ${message}`, "Never edit generated files; reseal an authorized amendment with SEV3, then run: looprch init discover --accept-fingerprint");
  return new LrError("packet_failed", `phase_context.py failed: ${message}`);
}

function nextExpansionName(dir: string, role: string): string {
  let n = 1;
  if (existsSync(dir)) n += readdirSync(dir).filter((f) => f.startsWith(`${role}-exp-`)).length;
  return `${role}-exp-${n}.md`;
}

/** Build the exact-source packet for a role with the vendored toolkit; never truncated or summarized. */
export function buildPacket(root: string, phase: string, configRole: string, exp: ExpansionOpts = {}): Packet {
  const role = PACKET_ROLE[configRole];
  if (!role) throw new LrError("no_packet_role", `Role ${configRole} has no SEV3 packet`);
  const expanding = !!(exp.documents?.length || exp.phases?.length);
  if (expanding && configRole === "implementer")
    throw new LrError("implementer_expansion", "The Implementer requests missing cross-phase context through the Planner; Looprch never executes it directly");
  const dir = join(projectPaths(root).packets, phase);
  const file = join(dir, expanding ? nextExpansionName(dir, role) : `${role}.md`);
  const args = ["--root", root, "--phase", phase, "--role", role, "--output", file];
  for (const d of exp.documents ?? []) args.push("--include-document", d);
  for (const p of exp.phases ?? []) args.push("--include-phase", p);
  if (expanding) {
    if (!exp.question || !exp.reason) throw new LrError("expansion_invalid", "An expansion needs an explicit question and reason");
    args.push("--question", exp.question, "--reason", exp.reason);
  }
  const r = runTool("phase_context.py", args);
  if (r.code !== 0 || r.json?.ok !== true) throw classifyError(String(r.errorJson?.error ?? (r.stderr.trim() || "unknown error")));
  return { path: relative(root, file), bytes: Number(r.json.bytes ?? 0), sources: Number(r.json.sources ?? 0) };
}
