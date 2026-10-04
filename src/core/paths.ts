import { homedir } from "node:os";
import { join } from "node:path";

export function looprchHome(): string {
  return process.env.LOOPRCH_HOME || join(homedir(), ".looprch");
}

export const home = {
  root: () => looprchHome(),
  versions: () => join(looprchHome(), "versions"),
  version: (v: string) => join(looprchHome(), "versions", v),
  current: () => join(looprchHome(), "current"),
  skills: () => join(looprchHome(), "current", "assets", "skills"),
  registry: () => join(looprchHome(), "projects.json"),
  cache: () => join(looprchHome(), "cache"),
  doctorCache: () => join(looprchHome(), "cache", "doctor.json"),
  quotaCache: () => join(looprchHome(), "cache", "quota.json"),
  shim: () => join(homedir(), ".local", "bin", "looprch"),
};

export function projectPaths(root: string) {
  const lr = join(root, ".looprch");
  return {
    root,
    lr,
    config: join(lr, "config.json"),
    state: join(lr, "state.json"),
    events: join(lr, "events.jsonl"),
    lock: join(lr, "lock"),
    backups: join(lr, "backups"),
    runs: join(lr, "runs"),
    run: (id: string) => join(lr, "runs", id),
    packets: join(lr, "packets"),
    testEvidence: join(lr, "test-evidence"),
    reports: join(lr, "reports"),
    phases: join(lr, "phases"),
    phase: (p: string) => join(lr, "phases", p),
    userRules: join(lr, "user-rules.md"),
    finalReport: join(lr, "FINAL_REPORT.md"),
    manifest: join(root, "phases", "manifest.json"),
    todo: join(root, "phases", "todo.md"),
  };
}

export type ProjectPaths = ReturnType<typeof projectPaths>;
