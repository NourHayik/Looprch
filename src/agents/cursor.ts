import { GENERATED_MARKER, RESULT_LINE, roleTitle, type AgentAdapter } from "./types.js";

export const cursor: AgentAdapter = {
  id: "cursor",
  displayName: "Cursor",
  binaries: ["cursor-agent", "agent"],
  skillDirs: [".agents/skills"],
  followsSymlinks: "unverified",
  invoke: (skill) => `/${skill}`,
  direct: {
    resumable: true,
    spawnHint: "Use your Task/subagent tool with the subagent named in `subagent` (defined in .cursor/agents/) and give it the brief path. Pass its id to record with --session if it returns one.",
    subagentFile: (role, model, readOnly) => ({
      path: `.cursor/agents/lr-${role}.md`,
      content: [
        "---",
        `name: lr-${role}`,
        `description: Looprch ${roleTitle(role)} role. Use only when Looprch hands you a brief.`,
        `model: ${model}`,
        ...(readOnly ? ["readonly: true"] : []),
        "---",
        `<!-- ${GENERATED_MARKER} -->`,
        RESULT_LINE,
        "",
      ].join("\n"),
    }),
  },
  delegate: {
    skill: "cursor-delegate",
    sessionField: "sessionId",
    resumeFlag: "--session",
    resumable: true,
    readOnly: "enforced",
    effortFlag: null,
    cleanEnv: false,
  },
  quotalensProvider: "cursor",
  envMarkers: ["CURSOR_AGENT", "CURSOR_CONVERSATION_ID"],
  postInstallNotes: ["Model names in the Cursor IDE subagent picker may differ from `cursor-agent models`; use the slug the CLI reports for Delegate runs."],
  generatedGlobs: [".cursor/agents/lr-*.md"],
  verified: { skills: "unverified", invoke: "unverified", direct: "not_run", resume: "not_run", readOnly: "not_run" },
};
