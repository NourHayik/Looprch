import { rmSync } from "node:fs";
import { LrError } from "../core/errors.js";
import { home } from "../core/paths.js";
import { removeShim } from "../install/shim.js";
import { listProjects } from "../install/registry.js";
import { askConfirm } from "../ui/prompts.js";
import { parse } from "./args.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, { yes: { type: "boolean", short: "y" } }, "looprch uninstall [--yes] [--json]");
  const projects = listProjects().map((p) => p.path);
  const msg = `Remove ${home.root()} and the looprch shim?${projects.length ? `\nRegistered projects keep their .looprch/ folders, but their skill links will break:\n  ${projects.join("\n  ")}` : ""}`;
  if (!(await askConfirm(msg, !!values.yes))) throw new LrError("cancelled", "Uninstall cancelled");
  const shimRemoved = removeShim();
  rmSync(home.root(), { recursive: true, force: true });
  out(!!values.json, { removed_home: home.root(), shim_removed: shimRemoved, projects_left: projects }, `Removed ${home.root()}${shimRemoved ? " and the shim" : ""}. Project .looprch/ folders were not touched.`);
  return 0;
}
