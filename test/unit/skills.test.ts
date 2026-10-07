import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../helpers/tmp.js";
import { SKILLS } from "../../src/core/constants.js";
import { ACTION_NAMES } from "../../src/core/actions.js";
import { humanStatus } from "../../src/cli/status.js";

const skill = (name: string) => readFileSync(join(REPO, "assets/skills", name, "SKILL.md"), "utf8");
const loop = (text: string) => /<!-- loop:begin -->[\s\S]*<!-- loop:end -->/.exec(text)?.[0];

describe("skills", () => {
  test("exactly the ten skills exist, each with name and description frontmatter", () => {
    assert.deepEqual(readdirSync(join(REPO, "assets/skills")).sort(), [...SKILLS].sort());
    for (const s of SKILLS) {
      const text = skill(s);
      assert.match(text, new RegExp(`^---\\nname: ${s}\\ndescription: .{20,}\\n---\\n`), s);
    }
  });

  test("the loop block is byte-identical in lr-phase, lr-auto, lr-resume and lr-finish", () => {
    const blocks = ["lr-phase", "lr-auto", "lr-resume", "lr-finish"].map((s) => loop(skill(s)));
    assert.ok(blocks[0]);
    for (const b of blocks) assert.equal(b, blocks[0]);
  });

  test("the loop block covers every action the CLI can return", () => {
    const block = loop(skill("lr-phase"))!;
    for (const a of ACTION_NAMES) assert.ok(block.includes(`\`${a}\``), `loop does not mention ${a}`);
  });

  test("the loop block tells the Lead to post the progress lines and never work silently", () => {
    const block = loop(skill("lr-phase"))!;
    assert.match(block, /## Reporting/);
    assert.match(block, /post every `progress` line in the chat exactly as given/);
    assert.match(block, /`Now: <what runs now>\. Next: <what follows>`/);
    assert.match(block, /Never work silently/);
  });

  test("every skill that runs next or a side run names all host ids", () => {
    for (const s of ["lr-phase", "lr-auto", "lr-resume", "lr-finish", "lr-init", "lr-review", "lr-worker"]) {
      for (const id of ["codex", "cursor", "agy", "kimi", "hermes", "opencode", "grok"]) assert.ok(skill(s).includes(`\`${id}\``), `${s} misses ${id}`);
    }
  });

  test("skills never tell the Lead to edit state or tick todo", () => {
    for (const s of SKILLS) assert.doesNotMatch(skill(s), /edit \.looprch\/state\.json|tick .*todo\.md yourself/i, s);
  });
});

describe("status rendering", () => {
  test("human status snapshot", () => {
    const text = humanStatus({
      version: "0.1.0",
      project: { id: "corebit", title: "Corebit" },
      spec: { package_fingerprint: "0a13ffff", phases_total: 89, phases_closed: 2 },
      current: { phase: "P-003", title: "Tenant registry", index: 3, stage: "testing", round: 1, cap: 3, test_repairs: 0, review_changes: 1, review_cap: 3, final_review_pending: false, contract_revision: 2, design: null, finding_ledger: {} },
      active: { run_id: "P-003-tester-2", role: "tester", agent: "codex", mode: "delegate", effective_mode: "delegate", mode_reason: "configured", session_id: "019a1234", started_at: "", elapsed_s: 360, status: "running" },
      last_result: { role: "implementer", decision: "implemented", summary: "implementer implemented (opencode)", touched_files: 14 },
      flags: { pause_requested: false, paused: null, waiting: null, blocked: null },
      pending_question: null,
      project_status: "in_progress",
      next: { action: "x", summary: "run gates after the tester report" },
    });
    assert.equal(
      text,
      [
        "Looprch 0.1.0 · project corebit · spec 89 phases (fingerprint 0a13…) · 2 closed",
        'Phase P-003 (3/89) "Tenant registry"  stage: testing  repair round 1 (test/gate repairs 0/3)  review changes 1/3',
        "Active: tester · codex · delegate · session 019a1234 · running for 6 min",
        "Last result: implementer implemented (opencode) · 14 files touched",
        "Blockers: none    Next: run gates after the tester report",
      ].join("\n"),
    );
  });
});
