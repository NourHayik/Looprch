import { GENERATED_MARKER, RESULT_LINE, roleTitle, type AgentAdapter } from "./types.js";

export const codex: AgentAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  binaries: ["codex"],
  skillDirs: [".agents/skills"],
  followsSymlinks: true,
  invoke: (skill) => `$${skill}`,
  direct: {
    resumable: false,
    spawnHint: "Spawn the Codex subagent named in `subagent` (defined in .codex/agents/) and give it the brief path.",
    subagentFile: (role, model, readOnly) => ({
      path: `.codex/agents/lr-${role}.toml`,
      content: [
        `# ${GENERATED_MARKER}`,
        `name = "lr-${role}"`,
        `description = "Looprch ${roleTitle(role)} role"`,
        `model = ${JSON.stringify(model)}`,
        ...(readOnly ? [`sandbox_mode = "read-only"`] : []),
        `developer_instructions = ${JSON.stringify(RESULT_LINE)}`,
        "",
      ].join("\n"),
    }),
  },
  delegate: {
    skill: "codex-delegate",
    sessionField: "threadId",
    resumeFlag: "--session",
    resumable: true,
    readOnly: "enforced",
    effortFlag: "--effort",
    cleanEnv: true,
  },
  quotalensProvider: "codex",
  envMarkers: ["CODEX_THREAD_ID", "CODEX_SANDBOX"],
  postInstallNotes: ["Codex needs a git repository for `codex exec`; Looprch creates one before the first phase."],
  generatedGlobs: [".codex/agents/lr-*.toml"],
  verified: { skills: "unverified", invoke: "unverified", direct: "not_run", resume: "not_run", readOnly: "not_run" },
};
