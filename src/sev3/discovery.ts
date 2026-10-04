import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SEV3_SCHEMA, TOOLKIT_VERSION } from "../core/constants.js";
import { LrError } from "../core/errors.js";
import { sha256 } from "../install/manifest.js";
import { type Manifest } from "./manifest.js";
import { checkToolkitTrust } from "./trust.js";
import { packageFingerprint, sourceFingerprint, verifyPackage, type VerifyResult } from "./fingerprint.js";
import { TOOL_FILES } from "./toolkit.js";

export const KNOWN_TOOLKITS = [TOOLKIT_VERSION];

export interface DiscoverResult {
  ok: boolean;
  root: string;
  project: { id: string; title: string } | null;
  schema_version: string | null;
  toolkit_version: string | null;
  toolkit_trusted: boolean;
  tool_mismatches: string[];
  extra_tool_files: string[];
  verify: Omit<VerifyResult, "ms" | "error"> & { error: string | null };
  package_fingerprint: string | null;
  source_fingerprint: string | null;
  manifest_sha256: string | null;
  phases: { id: string; number: number; title: string; kind: string; risk: string; work_class: string; gates: number }[];
  closure_phase: string | null;
  gate_commands: { argv0: string; count: number }[];
  gates_acknowledged: boolean;
  unreadable_files: string[];
  errors: string[];
  verify_ms: number;
}

function findInSubfolders(root: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(root, name, "phases", "manifest.json");
    try {
      if (statSync(join(root, name)).isDirectory() && existsSync(p)) found.push(`${name}/phases/manifest.json`);
    } catch {
      // unreadable entry
    }
  }
  return found;
}

export function locateManifest(root: string): Manifest {
  const p = join(root, "phases", "manifest.json");
  if (!existsSync(p)) {
    const sub = findInSubfolders(root);
    if (sub.length)
      throw new LrError(
        "package_in_subfolder",
        `Found a SEV3 package in a subfolder (${sub.join(", ")}), but Looprch v1 needs the package at the project root`,
        "Move the package contents (phases/, requirements/) to the project root. SEV3 tools only write under <root>/.looprch/ and gate evidence paths assume it.",
      );
    throw new LrError("no_package", `No SEV3 package at ${root}: phases/manifest.json not found`, "Put the SEV3 package (phases/ and requirements/) at the project root.");
  }
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(p, "utf8")) as Manifest;
  } catch (err) {
    throw new LrError("manifest_invalid", `phases/manifest.json is not valid JSON: ${(err as Error).message}`);
  }
  if (m.schema_version !== SEV3_SCHEMA) throw new LrError("not_sev3", `phases/manifest.json has schema_version ${JSON.stringify(m.schema_version)}; expected ${SEV3_SCHEMA}`);
  if (!KNOWN_TOOLKITS.includes(m.toolkit_version))
    throw new LrError("unknown_toolkit", `The package uses SEV3 toolkit ${m.toolkit_version}; this Looprch knows ${KNOWN_TOOLKITS.join(", ")}`, "Update Looprch: looprch update");
  return m;
}

function referencedPaths(m: Manifest): string[] {
  const paths = new Set<string>(["phases/manifest.json", "phases/package-lock.json", "phases/tooling-lock.json", "phases/refinement.json", "phases/todo.md", "phases/research.md", "phases/AGENTS.md", "phases/EXECUTION_GUIDE.md"]);
  for (const d of m.documents ?? []) paths.add(d.en);
  for (const p of m.phases ?? []) {
    paths.add(p.en);
    paths.add(`phases/context/en/${p.id}.md`);
  }
  for (const t of TOOL_FILES) paths.add(`phases/tools/${t}`);
  return [...paths];
}

export function unreadableFiles(root: string, m: Manifest): string[] {
  const out: string[] = [];
  const uid = process.getuid?.() ?? -1;
  for (const rel of referencedPaths(m)) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    try {
      accessSync(p, constants.R_OK);
    } catch {
      const st = statSync(p);
      const mode = (st.mode & 0o777).toString(8);
      out.push(st.uid !== uid ? `${rel} (mode ${mode}, owned by uid ${st.uid}, you are uid ${uid})` : `${rel} (mode ${mode})`);
    }
  }
  return out;
}

export function gateCommands(m: Manifest): { argv0: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of m.phases) for (const g of p.gates) counts.set(g.command[0]!, (counts.get(g.command[0]!) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([argv0, count]) => ({ argv0, count }));
}

export function manifestSha(root: string): string {
  return sha256(readFileSync(join(root, "phases", "manifest.json")));
}

export function discover(root: string, ackedSha: string | null): DiscoverResult {
  const m = locateManifest(root);
  const errors: string[] = [];
  const trust = checkToolkitTrust(root);
  if (!trust.trusted) errors.push(`The package's toolkit differs from Looprch's trusted SEV3 toolkit ${TOOLKIT_VERSION}: ${trust.mismatches.join(", ")}`);
  const unreadable = unreadableFiles(root, m);
  if (unreadable.length) errors.push(`Unreadable package files: ${unreadable.slice(0, 5).join("; ")}${unreadable.length > 5 ? " ..." : ""}`);
  let verify: VerifyResult = { ok: false, phase_count: null, requirement_count: null, semantic_translation_verified: false, application_verified: false, error: "not run", ms: 0 };
  let pkgFp: string | null = null;
  let srcFp: string | null = null;
  if (trust.trusted && unreadable.length === 0) {
    verify = verifyPackage(root);
    if (!verify.ok) errors.push(`verify_package.py failed: ${verify.error}`);
    else {
      pkgFp = packageFingerprint(root);
      srcFp = sourceFingerprint(root);
    }
  }
  const mSha = manifestSha(root);
  const closure = [...m.phases].reverse().find((p) => p.kind === "closure");
  return {
    ok: errors.length === 0,
    root,
    project: m.project ? { id: m.project.id, title: m.project.title } : null,
    schema_version: m.schema_version,
    toolkit_version: m.toolkit_version,
    toolkit_trusted: trust.trusted,
    tool_mismatches: trust.mismatches,
    extra_tool_files: trust.extra_files,
    verify: {
      ok: verify.ok,
      phase_count: verify.phase_count,
      requirement_count: verify.requirement_count,
      semantic_translation_verified: verify.semantic_translation_verified,
      application_verified: verify.application_verified,
      error: verify.error,
    },
    package_fingerprint: pkgFp,
    source_fingerprint: srcFp,
    manifest_sha256: mSha,
    phases: m.phases.map((p) => ({ id: p.id, number: p.number, title: p.title, kind: p.kind, risk: p.risk, work_class: p.work_class, gates: p.gates.length })),
    closure_phase: closure?.id ?? null,
    gate_commands: gateCommands(m),
    gates_acknowledged: ackedSha === mSha,
    unreadable_files: unreadable,
    errors,
    verify_ms: verify.ms,
  };
}
