import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LrError } from "../core/errors.js";
import { projectPaths } from "../core/paths.js";

export interface Gate {
  id: string;
  kind: "test" | "static" | "build" | "security" | "manual" | "integration";
  command: string[];
  negative: boolean;
  requirements: string[];
  evidence: { format: "unittest" | "junit" | "none"; path?: string };
  timeout_seconds?: number;
}

export interface PhaseDef {
  id: string;
  number: number;
  title: string;
  kind: "implementation" | "closure" | "documentation";
  risk: "low" | "medium" | "high" | "critical";
  work_class: string;
  en: string;
  owns: string[];
  uses?: { document: string; direction: string; reason: string }[];
  requires?: string[];
  requirements: string[];
  gates: Gate[];
  research?: string[];
  related?: { phase: string; relation: string; reason: string; documents: string[]; sections: string[] }[];
}

export interface Manifest {
  schema_version: string;
  toolkit_version: string;
  project: { id: string; title: string; canonical_language: string };
  documents: { id: string; kind: string; en: string; ids: string[] }[];
  phases: PhaseDef[];
}

export function manifestPath(root: string): string {
  return projectPaths(root).manifest;
}

export function readManifest(root: string): Manifest {
  const p = manifestPath(root);
  if (!existsSync(p)) throw new LrError("no_package", `No SEV3 package at ${root} (phases/manifest.json missing)`);
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  } catch (err) {
    throw new LrError("manifest_invalid", `phases/manifest.json is not valid JSON: ${(err as Error).message}`);
  }
}

export function phaseById(m: Manifest, id: string): PhaseDef {
  const p = m.phases.find((x) => x.id === id);
  if (!p) throw new LrError("unknown_phase", `Unknown phase ${id}`);
  return p;
}

/** Phases whose closed handovers are relevant to `phase`: related, requires and producers of used documents. */
export function relatedPhaseIds(m: Manifest, phase: PhaseDef): string[] {
  const owners = new Map<string, string>();
  for (const p of m.phases) for (const d of p.owns) owners.set(d, p.id);
  const ids = new Set<string>();
  for (const r of phase.related ?? []) if (r.relation !== "impact") ids.add(r.phase);
  for (const r of phase.requires ?? []) ids.add(r);
  for (const u of phase.uses ?? []) {
    const owner = owners.get(u.document);
    if (owner) ids.add(owner);
  }
  ids.delete(phase.id);
  return [...ids].sort();
}

export function phaseSourcePath(root: string, phase: PhaseDef): string {
  return join(root, phase.en);
}
