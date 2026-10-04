import { basename, join } from "node:path";
import { LrError } from "./errors.js";
import { writeJsonAtomic } from "./fsx.js";
import { now } from "./clock.js";

/** A pure function that turns a document of schema `from` into schema `from + 1`. */
export interface Migration {
  from: number;
  up: (doc: Record<string, unknown>) => Record<string, unknown>;
}

export function migrate(
  doc: Record<string, unknown>,
  kind: string,
  target: number,
  migrations: Migration[],
  backupDir: string | null,
  sourcePath: string | null,
): Record<string, unknown> {
  const version = typeof doc.schema_version === "number" ? doc.schema_version : 0;
  if (version > target)
    throw new LrError(
      "schema_too_new",
      `${kind} schema_version ${version} is newer than this Looprch supports (${target})`,
      "Update Looprch: looprch update",
    );
  if (version === target) return doc;
  if (backupDir && sourcePath) writeJsonAtomic(join(backupDir, `${basename(sourcePath)}.${now()}.json`), doc);
  let current = doc;
  for (let v = version; v < target; v++) {
    const step = migrations.find((m) => m.from === v);
    if (!step) throw new LrError("migration_missing", `No ${kind} migration from schema ${v} to ${v + 1}`);
    current = { ...step.up(current), schema_version: v + 1 };
  }
  if (sourcePath) writeJsonAtomic(sourcePath, current);
  return current;
}
