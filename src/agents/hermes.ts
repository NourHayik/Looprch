import type { AgentAdapter } from "./types.js";

export const hermes: AgentAdapter = {
  id: "hermes",
  displayName: "Hermes",
  binaries: ["hermes"],
  skillDirs: [".agents/skills"],
  followsSymlinks: "unverified",
  invoke: (skill) => `/${skill}`,
  envMarkers: ["HERMES_SESSION"],
  postInstallNotes: [
    "Run `hermes skills trust` in the project so Hermes loads the lr-* skills; the project must be a git repository, and only new Hermes sessions see them.",
    "Hermes reads only the first of .hermes.md, AGENTS.md; if you keep a .hermes.md, copy the Looprch block from AGENTS.md into it.",
    "Hermes can only be the Lead host: every role must be Delegate to another agent.",
  ],
  generatedGlobs: [],
  verified: { skills: "unverified", invoke: "unverified", direct: "not_run", resume: "false", readOnly: "false" },
};
