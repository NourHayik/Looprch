import { loadConfig, saveConfig } from "../core/config.js";
import { LrError, UsageError } from "../core/errors.js";
import { appendEvent } from "../core/journal.js";
import { withLock } from "../core/lock.js";
import { nowIso } from "../core/clock.js";
import { loadState, saveState } from "../core/state.js";
import { discover, type DiscoverResult } from "../sev3/discovery.js";
import { initGit } from "../git/baseline.js";
import { parse, projectRoot } from "./args.js";
import { out } from "./output.js";

const USAGE = `looprch init <subcommand>
  discover [--accept-fingerprint] [--json]      SEV3 discovery, toolkit trust, verification, fingerprints
  ack-gates --manifest-sha256 <sha> [--json]    acknowledge the gate commands for this manifest
  git [--baseline] [--json]                     create the git repository (and the baseline commit)`;

function humanDiscover(r: DiscoverResult & { fingerprint_changed: boolean }): string {
  const lines = [
    `SEV3 package: ${r.project?.title ?? "?"} (${r.project?.id ?? "?"}), ${r.phases.length} phases, closure ${r.closure_phase ?? "none"}`,
    `Toolkit ${r.toolkit_version}: ${r.toolkit_trusted ? "matches Looprch's trusted copy" : `UNTRUSTED (${r.tool_mismatches.join(", ")})`}`,
    `Specification verified: ${r.verify.ok ? "yes" : `no (${r.verify.error})`}; application verified: no (only execution can show that)`,
  ];
  if (r.package_fingerprint) lines.push(`Package fingerprint ${r.package_fingerprint.slice(0, 12)}…  source fingerprint ${r.source_fingerprint?.slice(0, 12)}…`);
  lines.push(`Gate commands (argv[0]): ${r.gate_commands.map((g) => `${g.argv0} ×${g.count}`).join(", ")}`);
  lines.push(r.gates_acknowledged ? "Gate commands acknowledged for this manifest." : `Gate commands NOT acknowledged. After review run: looprch init ack-gates --manifest-sha256 ${r.manifest_sha256}`);
  if (r.fingerprint_changed) lines.push("WARNING: the package fingerprint differs from the one recorded; pass --accept-fingerprint to accept it.");
  for (const e of r.errors) lines.push(`error: ${e}`);
  return lines.join("\n");
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "discover": {
      const { values } = parse(rest, { root: { type: "string" }, "accept-fingerprint": { type: "boolean" } }, USAGE);
      const root = projectRoot(values.root);
      return withLock(root, null, "init discover", () => {
        const cfg = loadConfig(root);
        const state = loadState(root);
        const r = discover(root, cfg.spec.gates_ack?.manifest_sha256 ?? null);
        const recorded = state.spec.package_fingerprint;
        const changed = !!(recorded && r.package_fingerprint && recorded !== r.package_fingerprint);
        if (r.ok && (!changed || values["accept-fingerprint"])) {
          state.spec = {
            package_fingerprint: r.package_fingerprint,
            source_fingerprint: r.source_fingerprint,
            manifest_sha256: r.manifest_sha256,
            toolkit_version: r.toolkit_version,
            phases_total: r.phases.length,
            verified_at: nowIso(),
          };
          if (changed && state.flags.blocked?.code === "spec_changed") state.flags.blocked = null;
          saveState(root, state);
          if (r.project && cfg.project.id !== r.project.id) {
            cfg.project.id = r.project.id;
            saveConfig(root, cfg);
          }
          appendEvent(root, { type: changed ? "spec.changed" : "init.discovered", data: { package_fingerprint: r.package_fingerprint, source_fingerprint: r.source_fingerprint, accepted: changed, verify_ms: r.verify_ms } });
        }
        const data = { ...r, fingerprint_changed: changed && !values["accept-fingerprint"] };
        out(!!values.json, data, () => humanDiscover(data));
        return r.ok ? 0 : 1;
      });
    }
    case "ack-gates": {
      const { values } = parse(rest, { root: { type: "string" }, "manifest-sha256": { type: "string" } }, USAGE);
      const root = projectRoot(values.root);
      const sha = values["manifest-sha256"];
      if (!sha) throw new UsageError("--manifest-sha256 is required (from looprch init discover)", USAGE);
      return withLock(root, null, "init ack-gates", () => {
        const cfg = loadConfig(root);
        const r = discover(root, null);
        if (r.manifest_sha256 !== sha) throw new LrError("manifest_changed", `The manifest hash is now ${r.manifest_sha256}; review the gate commands again`, "Run: looprch init discover");
        cfg.spec.gates_ack = { manifest_sha256: sha, acknowledged_at: nowIso(), commands: r.gate_commands };
        saveConfig(root, cfg);
        appendEvent(root, { type: "init.gates_acknowledged", data: { manifest_sha256: sha, commands: r.gate_commands } });
        out(!!values.json, { ok: true, gates_ack: cfg.spec.gates_ack }, `Gate commands acknowledged for manifest ${sha.slice(0, 12)}…`);
        return 0;
      });
    }
    case "git": {
      const { values } = parse(rest, { root: { type: "string" }, baseline: { type: "boolean" } }, USAGE);
      const root = projectRoot(values.root);
      return withLock(root, null, "init git", () => {
        const r = initGit(root, !!values.baseline);
        out(!!values.json, r, () => [r.initialized ? `Created a git repository on ${r.base_branch}` : `Git repository present (branch ${r.base_branch})`, r.baseline_commit ? `Baseline commit ${r.baseline_commit.slice(0, 10)}` : r.dirty.length ? `${r.dirty.length} uncommitted file(s); run again with --baseline to commit them as "looprch: baseline"` : "Working tree clean"].join("\n"));
        return 0;
      });
    }
    default:
      throw new UsageError(`Unknown init subcommand "${sub}"`, USAGE);
  }
}
