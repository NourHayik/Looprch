import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REPO } from "../helpers/tmp.js";
import { DECISIONS } from "../../src/core/results.js";

function markdown(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...markdown(p));
    else if (n.endsWith(".md")) out.push(p);
  }
  return out;
}

const USER_PAGES = ["index", "concepts", "install", "update-and-rollback", "quickstart", "attach-a-project", "lr-init", "roles-and-modes", "running-phases", "status-and-logs", "handover-and-git", "quota-and-fallbacks", "troubleshooting", "command-reference", "workflows-and-examples", "faq"];
const AGENT_PAGES = ["codex", "cursor", "antigravity", "kimi", "hermes", "opencode", "grok"];
const DEV_PAGES = ["architecture", "repository-structure", "cli-architecture", "shared-vs-project-state", "symlink-and-copy-strategy", "agent-adapters", "schemas", "lifecycle-state-machine", "bootstrap-and-preflight", "sev3-integration", "delegate-integration-and-sessions", "quota-integration", "git-integration", "update-versioning-migrations", "testing", "debugging", "spike-results", "contributing", "release-process"];

describe("documentation", () => {
  test("every planned page exists", () => {
    for (const p of USER_PAGES) assert.ok(existsSync(join(REPO, "docs/user", `${p}.md`)), `docs/user/${p}.md`);
    for (const p of AGENT_PAGES) assert.ok(existsSync(join(REPO, "docs/user/agents", `${p}.md`)), `docs/user/agents/${p}.md`);
    for (const p of DEV_PAGES) assert.ok(existsSync(join(REPO, "docs/dev", `${p}.md`)), `docs/dev/${p}.md`);
  });

  test("every relative link resolves", () => {
    const files = [...markdown(join(REPO, "docs")), join(REPO, "README.md"), join(REPO, "AGENTS.md")];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const path = resolve(dirname(f), target.split("#")[0]!);
        assert.ok(existsSync(path), `${f.slice(REPO.length + 1)} links to missing ${target}`);
      }
    }
  });

  test("every `looprch <command>` mentioned exists in the CLI", () => {
    const main = readFileSync(join(REPO, "src/cli/main.ts"), "utf8");
    const block = /const COMMANDS[^{]*\{([\s\S]*?)\n\};/.exec(main)![1]!;
    const known = new Set([...block.matchAll(/^\s*(?:"([\w-]+)"|(\w+))\s*[:,]/gm)].map((m) => m[1] ?? m[2]!));
    const files = [...markdown(join(REPO, "docs")), ...markdown(join(REPO, "assets/skills")), join(REPO, "README.md")];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/`looprch ([a-z][\w-]*)/g)) assert.ok(known.has(m[1]!), `${f.slice(REPO.length + 1)} mentions unknown command looprch ${m[1]}`);
    }
  });

  test("the role-results schema lists the same decisions as the validator", () => {
    const schema = JSON.parse(readFileSync(join(REPO, "schemas/role-results.schema.json"), "utf8"));
    for (const branch of schema.oneOf) {
      const role = branch.properties.role.const as keyof typeof DECISIONS;
      const decisions = branch.properties.decision.enum ?? [branch.properties.decision.const];
      assert.deepEqual([...decisions].sort(), [...DECISIONS[role]].sort(), role);
    }
  });
});
