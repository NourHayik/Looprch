import { listProjects } from "../install/registry.js";
import { parse } from "./args.js";
import { out } from "./output.js";

export async function run(argv: string[]): Promise<number> {
  const { values } = parse(argv, {}, "looprch list [--json]");
  const projects = listProjects();
  out(!!values.json, projects, () =>
    projects.length
      ? projects.map((p) => `${p.exists ? "" : "(missing) "}${p.path}  agents: ${p.agents.join(", ") || "-"}  last seen with ${p.last_seen_version}`).join("\n")
      : "No projects registered. Attach one with: looprch add .",
  );
  return 0;
}
