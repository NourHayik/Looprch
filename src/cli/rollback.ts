import { LrError } from "../core/errors.js";
import { currentVersion, previousVersion, switchCurrent } from "../install/central.js";
import { refreshRegisteredProjects } from "../install/links.js";
import { loadRegistry } from "../install/registry.js";
import { parse } from "./args.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, {}, "looprch rollback [--json]");
  const from = currentVersion();
  const to = previousVersion();
  if (!to) throw new LrError("no_previous", "No previous Looprch version is installed", "Install one with: looprch update --to <version>");
  switchCurrent(to);
  refreshRegisteredProjects(loadRegistry());
  out(!!values.json, { from, to }, `Rolled back Looprch ${from} -> ${to}`);
  return 0;
}
