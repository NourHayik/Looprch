import { GENERATED_MARKER, RESULT_LINE, roleTitle, type AgentAdapter } from "./types.js";

export const opencode: AgentAdapter = {
  id: "opencode",
  displayName: "OpenCode",
  binaries: ["opencode"],
  skillDirs: [".agents/skills"],
  followsSymlinks: true,
  invoke: (skill) => `/${skill}`,
  extraFiles: (skills) =>
    skills.map((skill) => ({
      path: `.opencode/commands/${skill}.md`,
      content: [
        "---",
        `description: Looprch ${skill} command`,
        "---",
        `<!-- ${GENERATED_MARKER} -->`,
        `Load and follow the skill at .agents/skills/${skill}/SKILL.md exactly. Arguments: $ARGUMENTS`,
        "",
      ].join("\n"),
    })),
  direct: {
    resumable: true,
    spawnHint: "Invoke the OpenCode subagent named in `subagent` (defined in .opencode/agents/) with the brief path.",
    subagentFile: (role, model, readOnly) => ({
      path: `.opencode/agents/lr-${role}.md`,
      content: [
        "---",
        `description: Looprch ${roleTitle(role)} role`,
        "mode: subagent",
        `model: ${model}`,
        ...(readOnly ? ["permission:", "  edit: deny", "  bash: deny"] : []),
        "---",
        `<!-- ${GENERATED_MARKER} -->`,
        RESULT_LINE,
        "",
      ].join("\n"),
    }),
  },
  delegate: {
    skill: "opencode-delegate",
    sessionField: "sessionId",
    resumeFlag: "--session",
    resumable: true,
    readOnly: "enforced",
    effortFlag: "--variant",
    cleanEnv: false,
    modelFormat: "provider/model",
  },
  quotalensProvider: "opencode",
  envMarkers: ["OPENCODE"],
  postInstallNotes: ["OpenCode models must be written as provider/model (see `opencode models`)."],
  generatedGlobs: [".opencode/commands/lr-*.md", ".opencode/agents/lr-*.md"],
  verified: { skills: "unverified", invoke: "unverified", direct: "not_run", resume: "not_run", readOnly: "not_run" },
};
